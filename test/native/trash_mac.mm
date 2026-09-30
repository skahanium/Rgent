#import <AppKit/AppKit.h>
#import <CommonCrypto/CommonDigest.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>

// Experimental executable, deliberately outside the product addon. No caller paths.
static NSString *Identity(NSString *p) {
  struct stat s;
  if (lstat(p.fileSystemRepresentation, &s) || !S_ISREG(s.st_mode)) return @"missing";
  return [NSString stringWithFormat:@"%llu:%llu", (unsigned long long)s.st_dev, (unsigned long long)s.st_ino];
}
static NSString *Hash(NSString *p) {
  int fd = open(p.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
  if (fd < 0) return @"missing";
  CC_SHA256_CTX ctx; CC_SHA256_Init(&ctx);
  unsigned char buffer[4096], digest[CC_SHA256_DIGEST_LENGTH];
  ssize_t n;
  while ((n = read(fd, buffer, sizeof(buffer))) > 0) CC_SHA256_Update(&ctx, buffer, (CC_LONG)n);
  close(fd);
  if (n < 0) return @"missing";
  CC_SHA256_Final(digest, &ctx);
  NSMutableString *result = [NSMutableString string];
  for (unsigned char byte : digest) [result appendFormat:@"%02x", byte];
  return result;
}
static void Dir(NSString *p) {
  NSError *e = nil;
  if (![[NSFileManager defaultManager] createDirectoryAtPath:p withIntermediateDirectories:YES attributes:nil error:&e]) @throw e;
}
static void File(NSString *p, NSString *token) {
  NSError *e = nil;
  if (![token writeToFile:p atomically:NO encoding:NSUTF8StringEncoding error:&e]) @throw e;
}
static NSDictionary *Object(NSString *p) { return @{ @"identity":Identity(p), @"sha256":Hash(p) }; }
static void Move(NSString *from, NSString *to) {
  if (rename(from.fileSystemRepresentation, to.fileSystemRepresentation)) @throw @"fixture rename failed";
}
int main(int argc, char **argv) {
  @autoreleasepool {
    NSSet *modes = [NSSet setWithArray:@[@"ordinary", @"file-replace", @"parent-swap", @"parent-link", @"reference-outside", @"same-name", @"partial"]];
    if (argc != 2 || ![modes containsObject:@(argv[1])]) return 2;
    NSString *mode = @(argv[1]);
    char templatePath[] = "/private/tmp/rgent-trash-proof-XXXXXX";
    char *baseRaw = mkdtemp(templatePath);
    if (!baseRaw) return 2;
    NSString *base = @(baseRaw);
    fprintf(stderr, "{\"fixtureRoot\":\"%s\"}\n", base.UTF8String);
    struct stat rootBefore; lstat(base.fileSystemRepresentation, &rootBefore);
    NSMutableDictionary *result = [@{ @"schemaVersion":@1, @"platform":@"macOS", @"mode":mode, @"fixtureRoot":base,
      @"systemPutBackVerified":@NO, @"cleanupKind":@"exact-receipt-rename-to-fixture", @"completed":@NO,
      @"experimentComplete":@NO, @"fixtureReclaimed":@NO, @"residualFixture":base } mutableCopy];
    int pinned = -1;
    @try {
      NSString *vault = [base stringByAppendingPathComponent:@"vault"];
      NSString *outside = [base stringByAppendingPathComponent:@"outside"];
      NSString *parent = [vault stringByAppendingPathComponent:@"parent"];
      Dir(parent); Dir(outside);
      NSString *note = [parent stringByAppendingPathComponent:@"note.md"];
      NSString *token = [NSString stringWithFormat:@"%@ original fixture\n", NSUUID.UUID.UUIDString];
      File(note, token);
      NSMutableDictionary *owned = [NSMutableDictionary dictionary], *ownedPaths = [NSMutableDictionary dictionary];
      NSDictionary *(^own)(NSString *) = ^NSDictionary *(NSString *path) {
        NSDictionary *object = Object(path);
        if ([object[@"identity"] isEqual:@"missing"] || [object[@"sha256"] isEqual:@"missing"]) @throw @"fixture identity or content unavailable";
        owned[object[@"identity"]] = object[@"sha256"]; ownedPaths[object[@"identity"]] = path; return object;
      };
      NSDictionary *expected = own(note);
      pinned = open(note.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW);
      if (pinned < 0) @throw @"pin failed";
      NSMutableArray<NSURL *> *urls = [NSMutableArray arrayWithObject:[NSURL fileURLWithPath:note]];
      NSMutableArray *expectations = [NSMutableArray arrayWithObject:expected];
      NSString *expectedPath = note;
      if ([mode isEqual:@"file-replace"]) {
        expectedPath = [parent stringByAppendingPathComponent:@"parked.md"];
        Move(note, expectedPath); ownedPaths[expected[@"identity"]] = expectedPath;
        File(note, [token stringByAppendingString:@"replacement\n"]); own(note);
      } else if ([mode isEqual:@"parent-swap"] || [mode isEqual:@"parent-link"] || [mode isEqual:@"reference-outside"]) {
        if ([mode isEqual:@"reference-outside"]) {
          NSURL *ref = urls[0].fileReferenceURL;
          if (!ref) @throw @"file reference unavailable";
          urls[0] = ref;
        }
        NSString *parked = [outside stringByAppendingPathComponent:@"original-parent"];
        Move(parent, parked); expectedPath = [parked stringByAppendingPathComponent:@"note.md"];
        ownedPaths[expected[@"identity"]] = expectedPath;
        if ([mode isEqual:@"parent-swap"]) {
          Dir(parent); File(note, [token stringByAppendingString:@"replacement parent\n"]); own(note);
        } else if ([mode isEqual:@"parent-link"]) {
          NSString *trap = [outside stringByAppendingPathComponent:@"trap"];
          Dir(trap); NSString *sentinel = [trap stringByAppendingPathComponent:@"note.md"];
          File(sentinel, [token stringByAppendingString:@"outside sentinel\n"]); own(sentinel);
          if (symlink(trap.fileSystemRepresentation, parent.fileSystemRepresentation)) @throw @"symlink failed";
        }
      } else if ([mode isEqual:@"same-name"]) {
        NSString *second = [vault stringByAppendingPathComponent:@"other/note.md"];
        Dir(second.stringByDeletingLastPathComponent); File(second, [token stringByAppendingString:@"second\n"]);
        NSDictionary *object = own(second);
        [urls addObject:[NSURL fileURLWithPath:second]]; [expectations addObject:object];
      } else if ([mode isEqual:@"partial"]) {
        [urls addObject:[NSURL fileURLWithPath:[vault stringByAppendingPathComponent:@"missing.md"]]];
        [expectations addObject:@{ @"identity":@"missing", @"sha256":@"missing" }];
      }
      result[@"expectedObjectStillInVaultAtDispatch"] = @([expectedPath hasPrefix:[vault stringByAppendingString:@"/"]]);
      __block BOOL done = NO;
      __block NSDictionary *receipts = nil;
      __block NSError *error = nil;
      dispatch_async(dispatch_get_main_queue(), ^{
        [[NSWorkspace sharedWorkspace] recycleURLs:urls completionHandler:^(NSDictionary *newURLs, NSError *e) {
          NSMutableArray *manifest = [NSMutableArray array];
          for (NSURL *source in newURLs) [manifest addObject:@{ @"source":source.absoluteString, @"receipt":[newURLs[source] absoluteString], @"actual":Object([newURLs[source] path]) }];
          [[NSJSONSerialization dataWithJSONObject:manifest options:0 error:nil] writeToFile:[base stringByAppendingPathComponent:@"receipts.json"] atomically:YES];
          receipts = newURLs; error = e; done = YES;
        }];
      });
      NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:30];
      while (!done && deadline.timeIntervalSinceNow > 0) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.02]];
      result[@"completed"] = @(done); result[@"errorCode"] = @(error.code);
      result[@"errorDomain"] = error.domain ?: @"";
      NSMutableArray *rows = [NSMutableArray array];
      BOOL cleanup = done;
      // Baseline/race evidence requires a real recycle receipt; a sandbox refusal is not a passing experiment.
      BOOL complete = done && receipts.count == ([mode isEqual:@"partial"] ? 1 : urls.count);
      for (NSURL *source in receipts) if (![urls containsObject:source]) { cleanup = NO; complete = NO; }
      for (NSUInteger i = 0; i < urls.count; i++) {
        NSURL *original = urls[i], *trash = receipts[original];
        NSDictionary *actual = trash ? Object(trash.path) : @{ @"identity":@"missing", @"sha256":@"missing" };
        NSDictionary *wanted = expectations[i];
        BOOL ours = trash && [owned[actual[@"identity"]] isEqual:actual[@"sha256"]];
        BOOL match = trash && [actual isEqual:wanted];
        BOOL originalExists = [[NSFileManager defaultManager] fileExistsAtPath:original.path];
        NSMutableDictionary *row = [@{ @"source":original.absoluteString, @"receipt":trash.absoluteString ?: @"", @"expected":wanted,
          @"actual":actual, @"expectedIdentityAndHash":@(match), @"ownedFixture":@(ours), @"originalExists":@(originalExists),
          @"reclaimed":@NO } mutableCopy];
        if (trash) {
          NSString *reclaimed = [base stringByAppendingPathComponent:[NSString stringWithFormat:@"reclaimed-%lu", (unsigned long)i]];
          if (!ours || rename(trash.path.fileSystemRepresentation, reclaimed.fileSystemRepresentation) || ![Object(reclaimed) isEqual:actual]) cleanup = NO;
          else { row[@"reclaimed"] = @YES; ownedPaths[actual[@"identity"]] = reclaimed; }
        } else if (![wanted[@"identity"] isEqual:@"missing"]) {
          // A failed recycle may be observed, but losing a file without an exact receipt is incomplete evidence.
          if (!originalExists || ![Identity(expectedPath) isEqual:expected[@"identity"]]) complete = NO;
        }
        [rows addObject:row];
      }
      BOOL accounted = YES;
      for (NSString *identity in owned) {
        NSDictionary *actual = Object(ownedPaths[identity]);
        if (![actual[@"identity"] isEqual:identity] || ![actual[@"sha256"] isEqual:owned[identity]]) accounted = NO;
      }
      if (!accounted) { complete = NO; cleanup = NO; result[@"probeError"] = @"A fixture object has no verified surviving path or reclaimed receipt"; }
      result[@"ownedFixtureObjectsAccounted"] = @(accounted);
      close(pinned); pinned = -1;
      result[@"items"] = rows; result[@"experimentComplete"] = @(complete);
      struct stat rootAfter;
      cleanup = cleanup && !lstat(base.fileSystemRepresentation, &rootAfter) && rootBefore.st_dev == rootAfter.st_dev && rootBefore.st_ino == rootAfter.st_ino;
      if (cleanup) {
        NSError *removeError = nil;
        cleanup = [[NSFileManager defaultManager] removeItemAtPath:base error:&removeError];
        if (removeError) result[@"cleanupError"] = removeError.localizedDescription;
      }
      result[@"fixtureReclaimed"] = @(cleanup); result[@"residualFixture"] = cleanup ? @"" : base;
    } @catch (id exception) {
      result[@"probeError"] = [exception description]; result[@"experimentComplete"] = @NO;
      result[@"fixtureReclaimed"] = @NO; result[@"residualFixture"] = base;
    }
    if (pinned >= 0) close(pinned);
    NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
    puts([[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String);
    return [result[@"experimentComplete"] boolValue] && [result[@"fixtureReclaimed"] boolValue] ? 0 : 1;
  }
}
