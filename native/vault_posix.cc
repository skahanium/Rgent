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
#endif

#include <atomic>
#include <stdexcept>
#include <utility>

namespace rgent {
namespace {

std::atomic<uint64_t> sequence{0};

[[noreturn]] void Fail(const char* code) { throw std::runtime_error(code); }

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

Fd OpenChildDir(int parent, const std::string& name) {
  Fd child(openat(parent, name.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
  CheckOpen(child.value);
  return child;
}

Fd Dir(VaultHandle* root, const std::vector<std::string>& parts, size_t count) {
  Fd current = DupRoot(root);
  for (size_t i = 0; i < count; ++i) current = OpenChildDir(current.value, parts[i]);
  return current;
}

Fd File(int parent, const std::string& name) {
  Fd file(openat(parent, name.c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC));
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

void ExpectExisting(int parent, const std::string& name, const std::optional<std::string>& expected) {
  if (!expected) {
    struct stat info;
    if (fstatat(parent, name.c_str(), &info, AT_SYMLINK_NOFOLLOW) == 0) Fail("CONFLICT");
    if (errno != ENOENT) Fail("IO_ERROR");
    return;
  }
  Fd current = File(parent, name);
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
  return out;
}

std::vector<Component> Resolve(VaultHandle* root, const std::string& relative_path) {
  const auto parts = Parts(relative_path);
  std::vector<Component> out;
  Fd parent = DupRoot(root);
  for (size_t i = 0; i < parts.size(); ++i) {
    const bool last = i + 1 == parts.size();
    Fd child(openat(parent.value, parts[i].c_str(), O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC |
            (last ? 0 : O_DIRECTORY)));
    CheckOpen(child.value);
    struct stat info;
    if (fstat(child.value, &info) != 0 || (!last && !S_ISDIR(info.st_mode)) ||
        (last && !S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode))) Fail("UNSAFE_PATH");
    out.push_back({ActualName(parent.value, info), Id(info), Kind(info.st_mode)});
    parent = std::move(child);
  }
  return out;
}

std::string ReadBytes(VaultHandle* root, const std::string& relative_file) {
  const auto parts = Parts(relative_file);
  Fd parent = Dir(root, parts, parts.size() - 1);
  Fd file = File(parent.value, parts.back());
  return ReadFd(file.value);
}

void Replace(VaultHandle* root, const std::string& relative_file,
             const std::optional<std::string>& expected, const std::string& content) {
  const auto parts = Parts(relative_file);
  Fd parent = Dir(root, parts, parts.size() - 1);
  const auto& leaf = parts.back();
  ExpectExisting(parent.value, leaf, expected);
  mode_t mode = 0600;
  if (expected) {
    struct stat info;
    if (fstatat(parent.value, leaf.c_str(), &info, AT_SYMLINK_NOFOLLOW) != 0 ||
        !S_ISREG(info.st_mode)) Fail("CONFLICT");
    mode = info.st_mode & 0777;
  }
  std::string temp;
  Fd file;
  for (int attempt = 0; attempt < 10; ++attempt) {
    temp = ".rgent-" + std::to_string(getpid()) + "-" + std::to_string(++sequence) + ".tmp";
    file = Fd(openat(parent.value, temp.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode));
    if (file.value >= 0) break;
    if (errno != EEXIST) CheckOpen(file.value);
  }
  CheckOpen(file.value);
  bool created = true;
  try {
    WriteFd(file.value, content);
    if (fsync(file.value) != 0) Fail("IO_ERROR");
    ExpectExisting(parent.value, leaf, expected);
    // A missing target must remain missing until commit. Plain renameat would
    // overwrite a file created after the last revision check.
#ifdef __APPLE__
    const int renamed = expected
      ? renameat(parent.value, temp.c_str(), parent.value, leaf.c_str())
      : renameatx_np(parent.value, temp.c_str(), parent.value, leaf.c_str(), RENAME_EXCL);
#else
    const int renamed = renameat(parent.value, temp.c_str(), parent.value, leaf.c_str());
#endif
    if (renamed != 0) {
      if (!expected && errno == EEXIST) Fail("CONFLICT");
      Fail("IO_ERROR");
    }
    created = false;
    (void)fsync(parent.value);
  } catch (...) {
    if (created) (void)unlinkat(parent.value, temp.c_str(), 0);
    throw;
  }
}

void Create(VaultHandle* root, const std::string& relative_file) {
  const auto parts = Parts(relative_file);
  Fd parent = Dir(root, parts, parts.size() - 1);
  Fd file(openat(parent.value, parts.back().c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
  CheckOpen(file.value);
}

} // namespace rgent

#endif
