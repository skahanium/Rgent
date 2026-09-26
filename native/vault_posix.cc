#ifndef _WIN32

#include "vault_fs.h"

#include <cerrno>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <stdio.h>
#include <stdlib.h>
#else
#include <cstdlib>
#endif

#include <stdexcept>
#include <utility>

namespace rgent {
namespace {

#ifdef __APPLE__
constexpr int kResolveBeneath = O_RESOLVE_BENEATH;
#else
constexpr int kResolveBeneath = 0;
#endif

[[noreturn]] void Fail(const char* code) { throw std::runtime_error(code); }

/** 不可预测的临时名：同目录里的别的进程猜不到，也就抢不了。 */
std::string TemporaryName() {
  unsigned char bytes[8] = {};
#ifdef __APPLE__
  arc4random_buf(bytes, sizeof(bytes));
#else
  for (size_t i = 0; i < sizeof(bytes); ++i) bytes[i] = static_cast<unsigned char>(random());
#endif
  static constexpr char hex[] = "0123456789abcdef";
  std::string name = ".rgent-";
  for (const auto byte : bytes) {
    name.push_back(hex[byte >> 4]);
    name.push_back(hex[byte & 15]);
  }
  return name + ".tmp";
}

void CheckOpen(int fd) {
  if (fd >= 0) return;
  if (errno == ENOENT) Fail("ENOENT");
  if (errno == EEXIST) Fail("EEXIST");
  if (errno == ELOOP || errno == ENOTDIR) Fail("UNSAFE_PATH");
  Fail("IO_ERROR");
}

struct Fd {
  int value = -1;
  explicit Fd(int fd = -1) : value(fd) {}
  ~Fd() { if (value >= 0) close(value); }
  Fd(const Fd&) = delete;
  Fd& operator=(const Fd&) = delete;
  Fd(Fd&& other) noexcept : value(std::exchange(other.value, -1)) {}
  Fd& operator=(Fd&& other) noexcept {
    if (this != &other) { if (value >= 0) close(value); value = std::exchange(other.value, -1); }
    return *this;
  }
};

std::vector<std::string> Parts(const std::string& rel, bool allow_empty = false) {
  if (rel.empty()) {
    if (allow_empty) return {};
    Fail("BAD_PATH");
  }
  if (rel.front() == '/' || rel.back() == '/' || rel.find('\\') != std::string::npos ||
      rel.find('\0') != std::string::npos) Fail("BAD_PATH");
  std::vector<std::string> parts;
  size_t start = 0;
  while (start < rel.size()) {
    const size_t end = rel.find('/', start);
    const auto part = rel.substr(start, end == std::string::npos ? end : end - start);
    if (part.empty() || part == "." || part == "..") Fail("BAD_PATH");
    parts.push_back(part);
    if (end == std::string::npos) break;
    start = end + 1;
  }
  return parts;
}

Fd DupRoot(VaultHandle* root) {
  if (!root || root->closed) Fail("VAULT_CLOSED");
  Fd copy(dup(root->fd));
  CheckOpen(copy.value);
  return copy;
}

Fd Dir(VaultHandle* root, const std::vector<std::string>& parts, size_t count) {
  Fd current = DupRoot(root);
  if (count == 0) return current;
  std::string relative = parts[0];
  for (size_t i = 1; i < count; ++i) relative += "/" + parts[i];
  Fd child(openat(current.value, relative.c_str(),
                  O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | kResolveBeneath | O_CLOEXEC));
  CheckOpen(child.value);
  current = std::move(child);
  return current;
}

Fd File(int parent, const std::string& name) {
  Fd file(openat(parent, name.c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY |
                                  kResolveBeneath | O_CLOEXEC));
  CheckOpen(file.value);
  struct stat info;
  if (fstat(file.value, &info) != 0 || !S_ISREG(info.st_mode)) Fail("UNSAFE_PATH");
  return file;
}

std::string ReadFd(int fd) {
  std::string result;
  char buffer[65536];
  while (true) {
    const auto count = read(fd, buffer, sizeof(buffer));
    if (count == 0) break;
    if (count < 0) { if (errno == EINTR) continue; Fail("IO_ERROR"); }
    result.append(buffer, static_cast<size_t>(count));
  }
  return result;
}

void WriteFd(int fd, const std::string& data) {
  size_t done = 0;
  while (done < data.size()) {
    const auto count = write(fd, data.data() + done, data.size() - done);
    if (count < 0) { if (errno == EINTR) continue; Fail("IO_ERROR"); }
    if (count == 0) Fail("IO_ERROR");
    done += static_cast<size_t>(count);
  }
}

std::string Kind(mode_t mode) {
  if (S_ISLNK(mode)) return "link";
  if (S_ISDIR(mode)) return "dir";
  if (S_ISREG(mode)) return "file";
  return "other";
}

std::string Id(const struct stat& info) {
  return std::to_string(static_cast<uint64_t>(info.st_dev)) + ":" +
         std::to_string(static_cast<uint64_t>(info.st_ino));
}

bool SameObject(int left, int right) {
  struct stat a;
  struct stat b;
  if (fstat(left, &a) != 0 || fstat(right, &b) != 0) Fail("IO_ERROR");
  return a.st_dev == b.st_dev && a.st_ino == b.st_ino;
}

std::string ActualName(int parent, const struct stat& child) {
  Fd scan_fd(openat(parent, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  CheckOpen(scan_fd.value);
  DIR* stream = fdopendir(std::exchange(scan_fd.value, -1));
  if (!stream) Fail("IO_ERROR");
  std::string name;
  size_t matches = 0;
  while (auto* entry = readdir(stream)) {
    if (std::strcmp(entry->d_name, ".") == 0 || std::strcmp(entry->d_name, "..") == 0) continue;
    struct stat candidate;
    if (fstatat(parent, entry->d_name, &candidate, AT_SYMLINK_NOFOLLOW) != 0) continue;
    if (candidate.st_dev == child.st_dev && candidate.st_ino == child.st_ino) {
      name = entry->d_name;
      ++matches;
    }
  }
  closedir(stream);
  if (matches != 1) Fail("AMBIGUOUS_PATH");
  return name;
}

void ExpectExisting(int root, const std::string& relative, const std::optional<std::string>& expected) {
  if (!expected) {
    Fd current(openat(root, relative.c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY |
                                            kResolveBeneath | O_CLOEXEC));
    if (current.value >= 0) Fail("CONFLICT");
    if (errno != ENOENT) CheckOpen(current.value);
    return;
  }
  Fd current = File(root, relative);
  if (ReadFd(current.value) != *expected) Fail("CONFLICT");
}

} // namespace

VaultHandle* OpenRoot(const std::string& absolute_path) {
  if (absolute_path.empty() || absolute_path.front() != '/') Fail("BAD_PATH");
  Fd fd(open(absolute_path.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  CheckOpen(fd.value);
  auto* root = new VaultHandle();
  root->fd = std::exchange(fd.value, -1);
  return root;
}

void CloseRoot(VaultHandle* root) {
  if (root && !root->closed) {
    root->closed = true;
    close(root->fd);
    root->fd = -1;
  }
}

std::vector<Entry> List(VaultHandle* root, const std::string& relative_dir) {
  const auto parts = Parts(relative_dir, true);
  Fd directory = Dir(root, parts, parts.size());
  Fd scan_fd(openat(directory.value, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
  CheckOpen(scan_fd.value);
  DIR* stream = fdopendir(std::exchange(scan_fd.value, -1));
  if (!stream) Fail("IO_ERROR");
  std::vector<Entry> out;
  while (auto* entry = readdir(stream)) {
    if (std::strcmp(entry->d_name, ".") == 0 || std::strcmp(entry->d_name, "..") == 0) continue;
    struct stat info;
    if (fstatat(directory.value, entry->d_name, &info, AT_SYMLINK_NOFOLLOW) != 0) continue;
    out.push_back({entry->d_name, Kind(info.st_mode), static_cast<uint64_t>(info.st_size),
#ifdef __APPLE__
      static_cast<int64_t>(info.st_mtimespec.tv_sec) * 1000000000LL + info.st_mtimespec.tv_nsec
#else
      static_cast<int64_t>(info.st_mtim.tv_sec) * 1000000000LL + info.st_mtim.tv_nsec
#endif
    });
  }
  closedir(stream);
  Fd still_here = Dir(root, parts, parts.size());
  if (!SameObject(directory.value, still_here.value)) Fail("PATH_CHANGED");
  return out;
}

std::vector<Component> Resolve(VaultHandle* root, const std::string& relative_path) {
  const auto parts = Parts(relative_path);
  std::vector<Component> out;
  Fd root_fd = DupRoot(root);
  Fd parent(dup(root_fd.value));
  CheckOpen(parent.value);
  std::string prefix;
  for (size_t i = 0; i < parts.size(); ++i) {
    const bool last = i + 1 == parts.size();
    prefix += (prefix.empty() ? "" : "/") + parts[i];
    Fd child(openat(root_fd.value, prefix.c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY |
            kResolveBeneath | O_CLOEXEC |
            (last ? 0 : O_DIRECTORY)));
    CheckOpen(child.value);
    struct stat info;
    if (fstat(child.value, &info) != 0 || (!last && !S_ISDIR(info.st_mode)) ||
        (last && !S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode))) Fail("UNSAFE_PATH");
    out.push_back({ActualName(parent.value, info), Id(info), Kind(info.st_mode)});
    parent = std::move(child);
  }
  Fd still_here(openat(root_fd.value, relative_path.c_str(),
                       O_RDONLY | O_NONBLOCK | O_NOFOLLOW_ANY | kResolveBeneath | O_CLOEXEC));
  CheckOpen(still_here.value);
  if (!SameObject(parent.value, still_here.value)) Fail("PATH_CHANGED");
  return out;
}

std::string ReadBytes(VaultHandle* root, const std::string& relative_file) {
  (void)Parts(relative_file);
  Fd root_fd = DupRoot(root);
  Fd file = File(root_fd.value, relative_file);
  auto bytes = ReadFd(file.value);
  Fd still_here = File(root_fd.value, relative_file);
  if (!SameObject(file.value, still_here.value)) Fail("PATH_CHANGED");
  return bytes;
}

void Replace(VaultHandle* root, const std::string& relative_file,
             const std::optional<std::string>& expected, const std::string& content) {
  const auto parts = Parts(relative_file);
  Fd root_fd = DupRoot(root);
  ExpectExisting(root_fd.value, relative_file, expected);
  mode_t mode = 0600;
  if (expected) {
    struct stat info;
    Fd current = File(root_fd.value, relative_file);
    if (fstat(current.value, &info) != 0) Fail("IO_ERROR");
    mode = info.st_mode & 0777;
  }
  // 临时文件建在目标父目录里（与 Windows 一致）：跨挂载点不会 EXDEV，
  // 库根只读而子目录可写时也能保存；提交后要同步的正是这个目录。
  Fd parent = Dir(root, parts, parts.size() - 1);
  std::string temp;
  Fd file;
  for (int attempt = 0; attempt < 10; ++attempt) {
    temp = TemporaryName();
    file = Fd(openat(parent.value, temp.c_str(), O_WRONLY | O_CREAT | O_EXCL |
                                               O_NOFOLLOW_ANY | kResolveBeneath | O_CLOEXEC, mode));
    if (file.value >= 0) break;
    if (errno != EEXIST) CheckOpen(file.value);
  }
  CheckOpen(file.value);
  // O_CREAT 会把 mode 与 ~umask 相与，能悄悄削掉 group/other 位。
  // 显式补一次，保证存盘不改动用户文件的权限。
  if (fchmod(file.value, mode) != 0) {
    (void)unlinkat(parent.value, temp.c_str(), 0);
    Fail("IO_ERROR");
  }
  bool created = true;
  try {
    WriteFd(file.value, content);
    if (fsync(file.value) != 0) Fail("IO_ERROR");
    ExpectExisting(root_fd.value, relative_file, expected);
    // 来源与目标都在一次内核改名里从固定库根/固定父目录解析：
    // 被搬走的子目录或被换掉的符号链接都改不了提交去向。
#ifdef __APPLE__
    const unsigned int flags = RENAME_NOFOLLOW_ANY | RENAME_RESOLVE_BENEATH |
                               (expected ? 0 : RENAME_EXCL);
    const int renamed = renameatx_np(parent.value, temp.c_str(), root_fd.value,
                                    relative_file.c_str(), flags);
#else
    const int renamed = -1;
    errno = ENOTSUP;
#endif
    if (renamed != 0) {
      if (!expected && errno == EEXIST) Fail("CONFLICT");
      Fail("IO_ERROR");
    }
    created = false;
    // 改名已经提交，这里只是让它在断电后也可见。失败不能报成写盘失败——
    // 磁盘上已经是新内容，报错会让人以为没存上。
    (void)fsync(parent.value);
  } catch (...) {
    if (created) (void)unlinkat(parent.value, temp.c_str(), 0);
    throw;
  }
}

void Create(VaultHandle* root, const std::string& relative_file) {
  (void)Parts(relative_file);
  Fd root_fd = DupRoot(root);
  Fd file(openat(root_fd.value, relative_file.c_str(),
                 O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW_ANY |
                     kResolveBeneath | O_CLOEXEC, 0600));
  CheckOpen(file.value);
}

} // namespace rgent

#endif
