#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace rgent {

struct VaultHandle {
#ifdef _WIN32
  void* handle = nullptr;
#else
  int fd = -1;
#endif
  bool closed = false;
};

struct Entry {
  std::string name;
  std::string kind; // dir, file, link
  uint64_t size = 0;
  int64_t mtime_ns = 0;
};

struct Component {
  std::string name; // name as enumerated by the filesystem
  std::string id;   // volume/device and file ID, valid only for this lookup
  std::string kind;
};

VaultHandle* OpenRoot(const std::string& absolute_path);
void CloseRoot(VaultHandle* root);
std::vector<Entry> List(VaultHandle* root, const std::string& relative_dir);
std::vector<Component> Resolve(VaultHandle* root, const std::string& relative_path);
std::string ReadBytes(VaultHandle* root, const std::string& relative_file);
void Replace(VaultHandle* root, const std::string& relative_file,
             const std::optional<std::string>& expected, const std::string& content);
void Create(VaultHandle* root, const std::string& relative_file);

} // namespace rgent
