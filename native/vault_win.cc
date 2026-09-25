#ifdef _WIN32

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

#include "vault_fs.h"

#pragma comment(lib, "ntdll.lib")
#pragma comment(lib, "bcrypt.lib")

#ifndef OBJ_DONT_REPARSE
#define OBJ_DONT_REPARSE 0x00001000L
#endif

namespace rgent {
namespace {

constexpr ULONG kOpen = 1;
constexpr ULONG kCreate = 2;
constexpr ULONG kSynchronous = 0x20;
constexpr ULONG kNonDirectory = 0x40;
constexpr ULONG kOpenReparsePoint = 0x00200000;
constexpr DWORD kRenameReplace = 0x1;
constexpr DWORD kRenamePosix = 0x2;
constexpr int64_t kUnixEpochInFiletime = 116444736000000000LL;
constexpr NTSTATUS kNameNotFound = static_cast<NTSTATUS>(0xC0000034u);
constexpr NTSTATUS kPathNotFound = static_cast<NTSTATUS>(0xC000003Au);
constexpr NTSTATUS kNoSuchFile = static_cast<NTSTATUS>(0xC000000Fu);
constexpr NTSTATUS kNameCollision = static_cast<NTSTATUS>(0xC0000035u);

class UniqueHandle {
 public:
  UniqueHandle() = default;
  explicit UniqueHandle(HANDLE value) : value_(value) {}
  ~UniqueHandle() { reset(); }
  UniqueHandle(const UniqueHandle&) = delete;
  UniqueHandle& operator=(const UniqueHandle&) = delete;
  UniqueHandle(UniqueHandle&& other) noexcept : value_(other.release()) {}
  UniqueHandle& operator=(UniqueHandle&& other) noexcept {
    if (this != &other) { reset(other.release()); }
    return *this;
  }
  HANDLE get() const { return value_; }
  bool valid() const { return value_ != INVALID_HANDLE_VALUE && value_ != nullptr; }
  HANDLE release() { HANDLE value = value_; value_ = INVALID_HANDLE_VALUE; return value; }
  void reset(HANDLE value = INVALID_HANDLE_VALUE) {
    if (valid()) CloseHandle(value_);
    value_ = value;
  }

 private:
  HANDLE value_ = INVALID_HANDLE_VALUE;
};

[[noreturn]] void Fail(const char* code) { throw std::runtime_error(code); }

[[noreturn]] void WinError(const char* operation) {
  throw std::runtime_error(std::string(operation) + ":WIN32:" + std::to_string(GetLastError()));
}

[[noreturn]] void NtError(const char* operation, NTSTATUS status) {
  if (status == kNameNotFound || status == kPathNotFound || status == kNoSuchFile) Fail("ENOENT");
  if (status == kNameCollision) Fail("EEXIST");
  throw std::runtime_error(std::string(operation) + ":NTSTATUS:" +
                           std::to_string(static_cast<uint32_t>(status)));
}

std::wstring Wide(const std::string& utf8) {
  if (utf8.empty()) return {};
  if (utf8.size() > static_cast<size_t>(std::numeric_limits<int>::max())) Fail("BAD_PATH");
  const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
                                      static_cast<int>(utf8.size()), nullptr, 0);
  if (size == 0) Fail("BAD_UTF8");
  std::wstring out(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8.data(),
                          static_cast<int>(utf8.size()), out.data(), size) != size) Fail("BAD_UTF8");
  return out;
}

std::string Utf8(const std::wstring& wide) {
  if (wide.empty()) return {};
  if (wide.size() > static_cast<size_t>(std::numeric_limits<int>::max())) Fail("BAD_PATH");
  const int size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
                                      static_cast<int>(wide.size()), nullptr, 0, nullptr, nullptr);
  if (size == 0) Fail("BAD_UTF16");
  std::string out(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide.data(),
                          static_cast<int>(wide.size()), out.data(), size, nullptr, nullptr) != size) Fail("BAD_UTF16");
  return out;
}

std::vector<std::wstring> Parts(const std::string& relative, bool allow_empty = false) {
  if (relative.empty()) {
    if (allow_empty) return {};
    Fail("BAD_PATH");
  }
  std::vector<std::wstring> out;
  size_t start = 0;
  while (start < relative.size()) {
    const auto end = relative.find('/', start);
    const auto byte_name = relative.substr(start, end == std::string::npos ? end : end - start);
    if (byte_name.empty() || byte_name == "." || byte_name == ".." ||
        byte_name.find('\\') != std::string::npos || byte_name.find(':') != std::string::npos ||
        byte_name.find('\0') != std::string::npos) Fail("BAD_PATH");
    // NtCreateFile receives exactly one child name; separators and ADS are never allowed.
    const auto name = Wide(byte_name);
    if (name.empty() || name.size() > 255 || name.find(L'\0') != std::wstring::npos) Fail("BAD_PATH");
    out.push_back(name);
    if (end == std::string::npos) break;
    start = end + 1;
    if (start == relative.size()) Fail("BAD_PATH");
  }
  return out;
}

HANDLE RootHandle(VaultHandle* root) {
  if (!root || root->closed || !root->handle) Fail("VAULT_CLOSED");
  return static_cast<HANDLE>(root->handle);
}

FILE_ATTRIBUTE_TAG_INFO Attributes(HANDLE handle) {
  FILE_ATTRIBUTE_TAG_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &info, sizeof(info)))
    WinError("FILE_ATTRIBUTES");
  return info;
}

std::string Kind(HANDLE handle) {
  const auto info = Attributes(handle);
  if ((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return "link";
  return (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? "dir" : "file";
}

void RequireKind(HANDLE handle, const char* expected) {
  if (Kind(handle) != expected) Fail("UNSAFE_PATH");
}

FILE_ID_INFO Identity(HANDLE handle) {
  FILE_ID_INFO info{};
  if (!GetFileInformationByHandleEx(handle, FileIdInfo, &info, sizeof(info)))
    WinError("FILE_ID");
  return info;
}

bool SameId(const FILE_ID_128& a, const FILE_ID_128& b) {
  return std::memcmp(a.Identifier, b.Identifier, sizeof(a.Identifier)) == 0;
}

std::string IdString(const FILE_ID_INFO& id) {
  static constexpr char hex[] = "0123456789abcdef";
  std::string out;
  out.reserve(16 + 1 + 32);
  for (int shift = 60; shift >= 0; shift -= 4) out.push_back(hex[(id.VolumeSerialNumber >> shift) & 15]);
  out.push_back(':');
  for (const auto byte : id.FileId.Identifier) {
    out.push_back(hex[byte >> 4]);
    out.push_back(hex[byte & 15]);
  }
  return out;
}

UniqueHandle OpenChild(HANDLE parent, const std::wstring& name, ACCESS_MASK access,
                       ULONG disposition, ULONG options, ULONG sharing) {
  UNICODE_STRING object_name{};
  object_name.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  object_name.Buffer = const_cast<PWSTR>(name.data());
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &object_name;
  // Match normal Windows path lookup; the opened handle still determines identity.
  attributes.Attributes = OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK io{};
  HANDLE child = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&child, access, &attributes, &io, nullptr,
                                      FILE_ATTRIBUTE_NORMAL, sharing, disposition,
                                      options | kOpenReparsePoint | kSynchronous, nullptr, 0);
  if (status < 0) NtError("OPEN_CHILD", status);
  return UniqueHandle(child);
}

UniqueHandle OpenMaybe(HANDLE parent, const std::wstring& name, ACCESS_MASK access,
                       ULONG options, ULONG sharing) {
  UNICODE_STRING object_name{};
  object_name.Length = static_cast<USHORT>(name.size() * sizeof(wchar_t));
  object_name.MaximumLength = object_name.Length;
  object_name.Buffer = const_cast<PWSTR>(name.data());
  OBJECT_ATTRIBUTES attributes{};
  attributes.Length = sizeof(attributes);
  attributes.RootDirectory = parent;
  attributes.ObjectName = &object_name;
  attributes.Attributes = OBJ_DONT_REPARSE | OBJ_CASE_INSENSITIVE;
  IO_STATUS_BLOCK io{};
  HANDLE child = INVALID_HANDLE_VALUE;
  const NTSTATUS status = NtCreateFile(&child, access, &attributes, &io, nullptr,
                                      FILE_ATTRIBUTE_NORMAL, sharing, kOpen,
                                      options | kOpenReparsePoint | kSynchronous, nullptr, 0);
  if (status == kNameNotFound || status == kPathNotFound || status == kNoSuchFile) return UniqueHandle();
  if (status < 0) NtError("OPEN_CHILD", status);
  return UniqueHandle(child);
}

struct DirectoryChain {
  HANDLE current = INVALID_HANDLE_VALUE;
  std::vector<UniqueHandle> owned;
};

DirectoryChain WalkDirectories(VaultHandle* root, const std::vector<std::wstring>& parts,
                               size_t count) {
  DirectoryChain chain;
  chain.current = RootHandle(root);
  chain.owned.reserve(count);
  for (size_t i = 0; i < count; ++i) {
    // Omitting FILE_SHARE_DELETE pins every ancestor against a concurrent move.
    auto child = OpenChild(chain.current, parts[i], MAXIMUM_ALLOWED | SYNCHRONIZE,
                           kOpen, 0, FILE_SHARE_READ | FILE_SHARE_WRITE);
    RequireKind(child.get(), "dir");
    chain.current = child.get();
    chain.owned.push_back(std::move(child));
  }
  return chain;
}

struct RawEntry {
  std::wstring name;
  FILE_ID_128 id{};
  DWORD attributes = 0;
  uint64_t size = 0;
  int64_t mtime_ns = 0;
};

std::vector<RawEntry> Enumerate(HANDLE directory) {
  std::vector<RawEntry> out;
  alignas(8) std::array<std::byte, 128 * 1024> buffer{};
  bool restart = true;
  while (true) {
    const auto info_class = restart ? FileIdExtdDirectoryRestartInfo : FileIdExtdDirectoryInfo;
    restart = false;
    if (!GetFileInformationByHandleEx(directory, info_class, buffer.data(),
                                      static_cast<DWORD>(buffer.size()))) {
      const auto code = GetLastError();
      if (code == ERROR_NO_MORE_FILES || code == ERROR_HANDLE_EOF) break;
      WinError("ENUMERATE");
    }
    size_t offset = 0;
    while (true) {
      if (offset + offsetof(FILE_ID_EXTD_DIR_INFO, FileName) > buffer.size()) Fail("BAD_DIRECTORY_INFO");
      const auto* row = reinterpret_cast<const FILE_ID_EXTD_DIR_INFO*>(buffer.data() + offset);
      const auto name_start = offset + offsetof(FILE_ID_EXTD_DIR_INFO, FileName);
      if (row->FileNameLength % sizeof(wchar_t) != 0 ||
          name_start + row->FileNameLength > buffer.size()) Fail("BAD_DIRECTORY_INFO");
      RawEntry item;
      item.name.assign(row->FileName, row->FileName + row->FileNameLength / sizeof(wchar_t));
      item.id = row->FileId;
      item.attributes = row->FileAttributes;
      item.size = row->EndOfFile.QuadPart < 0 ? 0 : static_cast<uint64_t>(row->EndOfFile.QuadPart);
      item.mtime_ns = (row->LastWriteTime.QuadPart - kUnixEpochInFiletime) * 100;
      if (item.name != L"." && item.name != L"..") out.push_back(std::move(item));
      if (row->NextEntryOffset == 0) break;
      if (row->NextEntryOffset < offsetof(FILE_ID_EXTD_DIR_INFO, FileName) ||
          offset + row->NextEntryOffset >= buffer.size()) Fail("BAD_DIRECTORY_INFO");
      offset += row->NextEntryOffset;
    }
  }
  return out;
}

std::wstring ActualName(HANDLE parent, const FILE_ID_INFO& identity) {
  const auto parent_id = Identity(parent);
  if (parent_id.VolumeSerialNumber != identity.VolumeSerialNumber) Fail("UNSAFE_PATH");
  std::wstring result;
  bool found = false;
  for (const auto& entry : Enumerate(parent)) {
    if (!SameId(entry.id, identity.FileId)) continue;
    if (found) Fail("AMBIGUOUS_ALIAS"); // Multiple hard links under one parent.
    result = entry.name;
    found = true;
  }
  if (!found) Fail("PATH_CHANGED");
  return result;
}

std::string ReadAll(HANDLE handle) {
  std::string out;
  std::array<char, 65536> buffer{};
  while (true) {
    DWORD read = 0;
    if (!ReadFile(handle, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr))
      WinError("READ");
    if (read == 0) break;
    out.append(buffer.data(), read);
  }
  return out;
}

void WriteAll(HANDLE handle, const std::string& bytes) {
  size_t offset = 0;
  while (offset < bytes.size()) {
    const auto count = static_cast<DWORD>(std::min<size_t>(bytes.size() - offset, 65536));
    DWORD written = 0;
    if (!WriteFile(handle, bytes.data() + offset, count, &written, nullptr)) WinError("WRITE");
    if (written == 0) Fail("WRITE_ZERO");
    offset += written;
  }
  if (!FlushFileBuffers(handle)) WinError("FLUSH");
}

std::wstring TemporaryName() {
  std::array<UCHAR, 16> random{};
  if (!BCRYPT_SUCCESS(BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()),
                                      BCRYPT_USE_SYSTEM_PREFERRED_RNG))) Fail("RANDOM_FAILED");
  static constexpr wchar_t hex[] = L"0123456789abcdef";
  std::wstring name = L".rgent-";
  for (const auto byte : random) {
    name.push_back(hex[byte >> 4]);
    name.push_back(hex[byte & 15]);
  }
  name += L".tmp";
  return name;
}

void DeleteOpenedFile(HANDLE handle) {
  FILE_DISPOSITION_INFO info{};
  info.DeleteFile = TRUE;
  if (!SetFileInformationByHandle(handle, FileDispositionInfo, &info, sizeof(info)))
    WinError("CLEANUP_TEMP");
}

void RenameOpenedFile(HANDLE source, HANDLE parent, const std::wstring& target,
                      bool replace) {
  const size_t bytes = target.size() * sizeof(wchar_t);
  // The Windows API validates against sizeof(FILE_RENAME_INFO), including
  // the structure's trailing alignment padding on 64-bit builds.
  const size_t length = sizeof(FILE_RENAME_INFO) + bytes + sizeof(wchar_t);
  std::vector<std::max_align_t> storage((length + sizeof(std::max_align_t) - 1) /
                                        sizeof(std::max_align_t));
  std::memset(storage.data(), 0, storage.size() * sizeof(std::max_align_t));
  auto* info = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  const DWORD flags = replace ? (kRenameReplace | kRenamePosix) : 0;
  std::memcpy(info, &flags, sizeof(flags));
  info->RootDirectory = parent;
  info->FileNameLength = static_cast<DWORD>(bytes);
  std::memcpy(info->FileName, target.data(), bytes);
  using NtSetInformationFileFn = NTSTATUS (NTAPI *)(HANDLE, PIO_STATUS_BLOCK, PVOID,
                                                    ULONG, FILE_INFORMATION_CLASS);
  const auto module = GetModuleHandleW(L"ntdll.dll");
  if (!module) WinError("NTDLL");
  const auto function = reinterpret_cast<NtSetInformationFileFn>(
      GetProcAddress(module, "NtSetInformationFile"));
  if (!function) WinError("NT_SET_INFORMATION_FILE");
  IO_STATUS_BLOCK io{};
  const auto status = function(source, &io, info, static_cast<ULONG>(length),
                               static_cast<FILE_INFORMATION_CLASS>(65)); // FileRenameInformationEx
  if (status < 0) {
    if (std::getenv("GITHUB_ACTIONS") != nullptr)
      std::fprintf(stderr, "::error title=Windows rename status::%lu\n",
                   static_cast<unsigned long>(status));
    NtError("RENAME", status);
  }
}

} // namespace

VaultHandle* OpenRoot(const std::string& absolute_path) {
  const auto wide = Wide(absolute_path);
  if (wide.empty() || wide.find(L'\0') != std::wstring::npos) Fail("BAD_PATH");
  UniqueHandle handle(CreateFileW(wide.c_str(), MAXIMUM_ALLOWED | SYNCHRONIZE,
                                  FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
                                  FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!handle.valid()) WinError("OPEN_ROOT");
  RequireKind(handle.get(), "dir");
  auto* result = new VaultHandle();
  result->handle = handle.release();
  return result;
}

void CloseRoot(VaultHandle* root) {
  if (!root || root->closed) return;
  root->closed = true;
  if (root->handle) CloseHandle(static_cast<HANDLE>(root->handle));
  root->handle = nullptr;
}

std::vector<Entry> List(VaultHandle* root, const std::string& relative_dir) {
  const auto parts = Parts(relative_dir, true);
  auto chain = WalkDirectories(root, parts, parts.size());
  std::vector<Entry> result;
  for (const auto& raw : Enumerate(chain.current)) {
    Entry entry;
    entry.name = Utf8(raw.name);
    entry.kind = (raw.attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 ? "link" :
                 (raw.attributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ? "dir" : "file";
    entry.size = raw.size;
    entry.mtime_ns = raw.mtime_ns;
    result.push_back(std::move(entry));
  }
  return result;
}

std::vector<Component> Resolve(VaultHandle* root, const std::string& relative_path) {
  const auto parts = Parts(relative_path);
  auto chain = WalkDirectories(root, {}, 0);
  std::vector<Component> result;
  result.reserve(parts.size());
  for (size_t i = 0; i < parts.size(); ++i) {
    const ACCESS_MASK access = FILE_READ_ATTRIBUTES | SYNCHRONIZE |
                               (i + 1 < parts.size() ? FILE_LIST_DIRECTORY : 0);
    auto child = OpenChild(chain.current, parts[i], access,
                           kOpen, 0, FILE_SHARE_READ | FILE_SHARE_WRITE);
    const auto kind = Kind(child.get());
    if (kind == "link" || (i + 1 < parts.size() && kind != "dir")) Fail("UNSAFE_PATH");
    const auto identity = Identity(child.get());
    result.push_back({Utf8(ActualName(chain.current, identity)), IdString(identity), kind});
    if (i + 1 < parts.size()) {
      chain.current = child.get();
      chain.owned.push_back(std::move(child));
    }
  }
  return result;
}

std::string ReadBytes(VaultHandle* root, const std::string& relative_file) {
  const auto parts = Parts(relative_file);
  auto chain = WalkDirectories(root, parts, parts.size() - 1);
  auto leaf = OpenChild(chain.current, parts.back(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                        kOpen, kNonDirectory, FILE_SHARE_READ);
  RequireKind(leaf.get(), "file");
  return ReadAll(leaf.get());
}

void Replace(VaultHandle* root, const std::string& relative_file,
             const std::optional<std::string>& expected, const std::string& content) {
  const auto parts = Parts(relative_file);
  auto chain = WalkDirectories(root, parts, parts.size() - 1);
  auto target = OpenMaybe(chain.current, parts.back(), FILE_READ_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                          kNonDirectory, FILE_SHARE_READ);
  if (target.valid()) RequireKind(target.get(), "file");
  if (expected) {
    if (!target.valid() || ReadAll(target.get()) != *expected) Fail("CONFLICT");
  } else if (target.valid()) {
    Fail("CONFLICT");
  }

  UniqueHandle temporary;
  for (int attempt = 0; attempt < 8; ++attempt) {
    const auto name = TemporaryName();
    try {
      temporary = OpenChild(chain.current, name,
                            FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | DELETE | SYNCHRONIZE,
                            kCreate, kNonDirectory, FILE_SHARE_READ | FILE_SHARE_DELETE);
      break;
    } catch (const std::runtime_error& error) {
      if (std::string(error.what()) != "EEXIST") throw;
    }
  }
  if (!temporary.valid()) Fail("TEMP_COLLISION");
  bool renamed = false;
  const char* phase = "WRITE";
  try {
    WriteAll(temporary.get(), content);
    // The target handle denies external writers and deletion through the check/rename interval.
    phase = "RENAME";
    RenameOpenedFile(temporary.get(), chain.current, parts.back(), expected.has_value());
    renamed = true;
  } catch (const std::exception& error) {
    if (std::getenv("GITHUB_ACTIONS") != nullptr) {
      std::fprintf(stderr, "::error title=Windows replace phase::%s:%s\n",
                   phase, error.what()[0] ? error.what() : "EMPTY");
    }
    if (!renamed) {
      try { DeleteOpenedFile(temporary.get()); } catch (...) { /* Preserve the original error. */ }
    }
    throw;
  } catch (...) {
    if (!renamed) {
      try { DeleteOpenedFile(temporary.get()); } catch (...) { /* Preserve the original error. */ }
    }
    throw;
  }
}

void Create(VaultHandle* root, const std::string& relative_file) {
  const auto parts = Parts(relative_file);
  auto chain = WalkDirectories(root, parts, parts.size() - 1);
  auto file = OpenChild(chain.current, parts.back(), FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                        kCreate, kNonDirectory, FILE_SHARE_READ);
  RequireKind(file.get(), "file");
  if (!FlushFileBuffers(file.get())) WinError("FLUSH");
}

} // namespace rgent

#endif // _WIN32
