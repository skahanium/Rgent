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
struct ReadSnapshotResult { std::string bytes; std::string object_version; };
ReadSnapshotResult ReadSnapshot(VaultHandle* root, const std::string& relative_file);
std::string ReadBytes(VaultHandle* root, const std::string& relative_file);
std::string Replace(VaultHandle* root, const std::string& relative_file,
             const std::optional<std::string>& expected, const std::string& content,
             const std::optional<std::string>& expected_id = std::nullopt);
void Create(VaultHandle* root, const std::string& relative_file);
void CreateVaultDirectory(VaultHandle* root, const std::string& relative_dir);
void Move(VaultHandle* root, const std::string& source, const std::string& target,
          const std::string& expected_id);
/** 送入系统废纸篓。macOS 核 expected_id 后调用 trashItem，返回落点路径（可空）。Windows 报 PLATFORM_UNPROVEN。 */
std::string Trash(VaultHandle* root, const std::string& rel_path, const std::string& expected_id);

} // namespace rgent
