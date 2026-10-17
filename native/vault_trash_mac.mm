#import <Foundation/Foundation.h>

#include <stdexcept>
#include <string>

namespace rgent {

std::string TrashItemAtAbsolutePath(const std::string& absolute_path) {
  @autoreleasepool {
    if (absolute_path.empty() || absolute_path.front() != '/') throw std::runtime_error("BAD_PATH");
    NSURL *url = [NSURL fileURLWithPath:@(absolute_path.c_str())];
    if (!url) throw std::runtime_error("BAD_PATH");
    NSURL *landing = nil;
    NSError *error = nil;
    if (![[NSFileManager defaultManager] trashItemAtURL:url resultingItemURL:&landing error:&error]) {
      throw std::runtime_error("IO_ERROR");
    }
    if (!landing) return {};
    const char *rep = landing.fileSystemRepresentation;
    return rep ? std::string(rep) : std::string();
  }
}

} // namespace rgent
