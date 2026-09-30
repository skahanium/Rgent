// Dedicated-fixture experiment. This is not linked into the product addon.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shobjidl.h>
#include <shellapi.h>
#include <winioctl.h>
#include <bcrypt.h>
#include <wrl/client.h>
#include <filesystem>
#include <algorithm>
#include <cstring>
#include <fstream>
#include <functional>
#include <iostream>
#include <map>
#include <sstream>
#include <string>
#include <vector>
#include <stdexcept>
using Microsoft::WRL::ComPtr;
namespace fs = std::filesystem;
// Never answer Yes to destructive prompts. Non-recyclable media/prompt timeouts leave
// evidence incomplete; FOF_WANTNUKEWARNING retains the permanent-destruction warning.
static constexpr DWORD flags = FOFX_RECYCLEONDELETE | FOF_NOERRORUI | FOFX_EARLYFAILURE | FOF_SILENT | FOF_WANTNUKEWARNING;
static std::string Utf8(const std::wstring &s) {
  if (s.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0, nullptr, nullptr);
  std::string out(n, 0); WideCharToMultiByte(CP_UTF8, 0, s.c_str(), (int)s.size(), out.data(), n, nullptr, nullptr); return out;
}
static std::string Q(const std::string &s) {
  std::ostringstream o; o << '"';
  for (unsigned char c : s) { if (c == '"' || c == '\\') o << '\\' << c; else if (c < 32) { const char *h="0123456789abcdef"; o << "\\u00" << h[c>>4] << h[c&15]; } else o << c; }
  o << '"'; return o.str();
}
static std::string B(bool b) { return b ? "true" : "false"; }
static void Check(bool ok, const char *what) { if (!ok) throw std::runtime_error(std::string(what) + ": " + std::to_string(GetLastError())); }
struct Handle {
  HANDLE h = INVALID_HANDLE_VALUE;
  explicit Handle(HANDLE value = INVALID_HANDLE_VALUE) : h(value) {}
  ~Handle() { if (h != INVALID_HANDLE_VALUE) CloseHandle(h); }
  Handle(const Handle &) = delete; Handle &operator=(const Handle &) = delete;
  void close() { if (h != INVALID_HANDLE_VALUE) CloseHandle(h); h = INVALID_HANDLE_VALUE; }
};
struct Object { std::string id="missing", hash="missing"; bool operator==(const Object &o) const { return id==o.id && hash==o.hash; } };
static std::string Id(HANDLE h) {
  BY_HANDLE_FILE_INFORMATION i{}; if (!GetFileInformationByHandle(h, &i)) return "missing";
  return std::to_string(i.dwVolumeSerialNumber)+":"+std::to_string(i.nFileIndexHigh)+":"+std::to_string(i.nFileIndexLow);
}
static Object Read(const fs::path &p) {
  Handle f(CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (f.h == INVALID_HANDLE_VALUE) return {};
  FILE_ATTRIBUTE_TAG_INFO tag{};
  if (!GetFileInformationByHandleEx(f.h, FileAttributeTagInfo, &tag, sizeof(tag)) || (tag.FileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))) return {};
  BCRYPT_ALG_HANDLE alg=nullptr; BCRYPT_HASH_HANDLE hash=nullptr; DWORD size=0, got=0;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return {};
  if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, (PUCHAR)&size, sizeof(size), &got, 0) < 0) { BCryptCloseAlgorithmProvider(alg,0); return {}; }
  std::vector<unsigned char> storage(size); unsigned char digest[32];
  bool ok=BCryptCreateHash(alg,&hash,storage.data(),size,nullptr,0,0)>=0;
  unsigned char buffer[4096]; DWORD n=0;
  while (ok) { if (!ReadFile(f.h,buffer,sizeof(buffer),&n,nullptr)) { ok=false; break; } if (!n) break; ok=BCryptHashData(hash,buffer,n,0)>=0; }
  if (ok) ok=BCryptFinishHash(hash,digest,sizeof(digest),0)>=0;
  if (hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(alg,0);
  if (!ok) return {};
  const char *hex="0123456789abcdef"; std::string result; for (auto c:digest) { result+=hex[c>>4]; result+=hex[c&15]; }
  return {Id(f.h),result};
}
static std::string Json(const Object &o) { return "{\"identity\":"+Q(o.id)+",\"sha256\":"+Q(o.hash)+"}"; }
static void File(const fs::path &p, const std::string &s) {
  Handle h(CreateFileW(p.c_str(),GENERIC_WRITE,FILE_SHARE_READ,nullptr,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,nullptr));
  Check(h.h!=INVALID_HANDLE_VALUE,"fixture create"); DWORD n=0;
  Check(WriteFile(h.h,s.data(),(DWORD)s.size(),&n,nullptr) && n==s.size(),"fixture write");
}
static fs::path ItemPath(IShellItem *item) {
  PWSTR p=nullptr; if (!item || FAILED(item->GetDisplayName(SIGDN_FILESYSPATH,&p))) return {};
  fs::path result(p); CoTaskMemFree(p); return result;
}
static std::string ItemName(IShellItem *item) {
  PWSTR p=nullptr; if (!item || FAILED(item->GetDisplayName(SIGDN_DESKTOPABSOLUTEPARSING,&p))) return {};
  auto result=Utf8(p); CoTaskMemFree(p); return result;
}
static ComPtr<IShellItem> Item(const fs::path &p) {
  ComPtr<IShellItem> i; HRESULT hr=SHCreateItemFromParsingName(p.c_str(),nullptr,IID_PPV_ARGS(&i));
  if (FAILED(hr)) throw std::runtime_error("ShellItem: "+std::to_string(hr)); return i;
}
static bool InVault(const fs::path &p,const std::string &vaultIdentity) {
  // Shell expands 8.3 paths. Compare ancestor identities instead of string prefixes,
  // rejecting every reparse ancestor. This diagnostic is still not an atomic guarantee.
  auto current=p.parent_path();
  while (!current.empty()) {
    Handle dir(CreateFileW(current.c_str(),0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    FILE_ATTRIBUTE_TAG_INFO tag{};
    if (dir.h==INVALID_HANDLE_VALUE || !GetFileInformationByHandleEx(dir.h,FileAttributeTagInfo,&tag,sizeof(tag))
      || !(tag.FileAttributes&FILE_ATTRIBUTE_DIRECTORY) || (tag.FileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)) return false;
    if (Id(dir.h)==vaultIdentity) return true;
    auto parent=current.parent_path(); if (parent==current) return false; current=parent;
  }
  return false;
}
static void Junction(const fs::path &link,const fs::path &target) {
  // Only points to a sibling under this process's unique fixture root. No external targets.
  fs::create_directory(link);
  Handle h(CreateFileW(link.c_str(),GENERIC_WRITE,0,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS,nullptr));
  Check(h.h!=INVALID_HANDLE_VALUE,"junction handle");
  std::wstring substitute=L"\\??\\"+target.native(), print=target.native();
  struct Mount { DWORD tag; WORD length,reserved; WORD subOffset,subLength,printOffset,printLength; WCHAR paths[1]; };
  std::vector<unsigned char> bytes(16+(substitute.size()+print.size()+2)*sizeof(WCHAR),0);
  auto *r=reinterpret_cast<Mount *>(bytes.data()); r->tag=IO_REPARSE_TAG_MOUNT_POINT;
  r->subLength=(WORD)(substitute.size()*2); r->printOffset=r->subLength+2; r->printLength=(WORD)(print.size()*2);
  memcpy(r->paths,substitute.c_str(),r->subLength); memcpy(reinterpret_cast<unsigned char *>(r->paths)+r->printOffset,print.c_str(),r->printLength);
  r->length=(WORD)(bytes.size()-8); DWORD n=0;
  Check(DeviceIoControl(h.h,FSCTL_SET_REPARSE_POINT,r,(DWORD)bytes.size(),nullptr,0,&n,nullptr)!=FALSE,"junction set");
}
struct Row {
  fs::path source, receiptPath; Object expected,actual; ComPtr<IShellItem> receipt;
  HRESULT queued=E_PENDING,post=E_PENDING,preResult=E_PENDING;
  bool pre=false,postCalled=false,finalCheck=false,preIdentity=false,preInVault=false,owned=false,reclaimed=false,sourceExists=false,manifestFailed=false;
  fs::path prePath;
  std::string receiptName; HRESULT restore=E_PENDING,restoreAbortedHr=E_PENDING; BOOL restoreAborted=TRUE;
};
class Sink final : public IFileOperationProgressSink {
  LONG references=1;
 public:
  std::vector<Row> &rows; size_t index; fs::path manifest; std::function<HRESULT(size_t,IShellItem*)> before;
  Sink(std::vector<Row>&r,size_t i,const fs::path &m,std::function<HRESULT(size_t,IShellItem*)> fn):rows(r),index(i),manifest(m),before(fn){}
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID id,void **p) override { if (!p) return E_POINTER; *p=nullptr; if (id==IID_IUnknown || id==IID_IFileOperationProgressSink) { *p=static_cast<IFileOperationProgressSink*>(this); AddRef(); return S_OK; } return E_NOINTERFACE; }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&references); }
  ULONG STDMETHODCALLTYPE Release() override { auto n=InterlockedDecrement(&references); if (!n) delete this; return n; }
  HRESULT STDMETHODCALLTYPE StartOperations() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE FinishOperations(HRESULT) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreRenameItem(DWORD,IShellItem*,LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostRenameItem(DWORD,IShellItem*,LPCWSTR,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreMoveItem(DWORD,IShellItem*,IShellItem*,LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostMoveItem(DWORD,IShellItem*,IShellItem*,LPCWSTR,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreCopyItem(DWORD,IShellItem*,IShellItem*,LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostCopyItem(DWORD,IShellItem*,IShellItem*,LPCWSTR,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PreDeleteItem(DWORD,IShellItem *i) override {
    rows[index].pre=true; HRESULT hr=before(index,i); rows[index].preResult=hr; return hr;
  }
  HRESULT STDMETHODCALLTYPE PostDeleteItem(DWORD,IShellItem*,HRESULT hr,IShellItem *receipt) override {
    auto &r=rows[index]; r.postCalled=true; r.post=hr; r.receipt=receipt;
    if (receipt) { r.receiptPath=ItemPath(receipt); r.receiptName=ItemName(receipt); r.actual=Read(r.receiptPath); }
    std::ofstream log(manifest,std::ios::app);
    log<<"{\"item\":"<<index<<",\"postDeleteHRESULT\":"<<(long)hr<<",\"receipt\":"<<Q(r.receiptName)<<",\"receiptPath\":"<<Q(Utf8(r.receiptPath.native()))<<",\"actual\":"<<Json(r.actual)<<"}\n";
    log.flush(); r.manifestFailed=!log.good();
    return r.manifestFailed ? E_FAIL : S_OK;
  }
  HRESULT STDMETHODCALLTYPE PreNewItem(DWORD,IShellItem*,LPCWSTR) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PostNewItem(DWORD,IShellItem*,LPCWSTR,LPCWSTR,DWORD,HRESULT,IShellItem*) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE UpdateProgress(UINT,UINT) override { return S_OK; }
  HRESULT STDMETHODCALLTYPE ResetTimer() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE PauseTimer() override { return S_OK; }
  HRESULT STDMETHODCALLTYPE ResumeTimer() override { return S_OK; }
};
static ComPtr<IFileOperation> Operation(DWORD operationFlags) {
  ComPtr<IFileOperation> op; HRESULT hr=CoCreateInstance(CLSID_FileOperation,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(&op));
  if (FAILED(hr)) throw std::runtime_error("IFileOperation: "+std::to_string(hr));
  hr=op->SetOperationFlags(operationFlags); if (FAILED(hr)) throw std::runtime_error("SetOperationFlags: "+std::to_string(hr)); return op;
}
int wmain(int argc,wchar_t **argv) {
  const std::vector<std::wstring> modes={L"ordinary",L"initial-file-replace",L"queued-file-replace",L"predelete-file-replace",L"initial-parent-move",L"queued-parent-move",L"predelete-parent-move",L"initial-junction",L"queued-junction",L"predelete-junction",L"same-name",L"partial",L"leaf-pin",L"parent-pin-replace"};
  if (argc!=2 || std::find(modes.begin(),modes.end(),argv[1])==modes.end()) return 2;
  std::wstring mode=argv[1]; HRESULT init=CoInitializeEx(nullptr,COINIT_APARTMENTTHREADED); if (FAILED(init)) { std::cout<<"{\"probeError\":\"STA initialization failed\",\"experimentComplete\":false,\"fixtureReclaimed\":false}\n"; return 1; }
  fs::path base; std::vector<Row> rows; std::map<std::string,std::string> owned;
  std::map<std::string,fs::path> ownedPaths;
  std::string error,rootId; HRESULT perform=E_PENDING,abortHr=E_PENDING; BOOL aborted=TRUE;
  bool cleanup=false,complete=false,accounted=false,injected=false,injectionBlocked=false; DWORD injectionError=0;
  Handle leaf,parentPin,identityPin;
  try {
    wchar_t temp[MAX_PATH+1]; Check(GetTempPathW(MAX_PATH,temp)>0,"temp directory");
    GUID guid{}; Check(SUCCEEDED(CoCreateGuid(&guid)),"fixture GUID"); wchar_t name[40]; StringFromGUID2(guid,name,40);
    base=fs::path(temp)/(L"rgent-trash-proof-"+std::wstring(name)); Check(CreateDirectoryW(base.c_str(),nullptr)!=FALSE,"unique fixture root");
    std::cerr<<"{\"fixtureRoot\":"<<Q(Utf8(base.native()))<<"}"<<std::endl;
    { Handle root(CreateFileW(base.c_str(),0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr)); Check(root.h!=INVALID_HANDLE_VALUE,"fixture root handle"); rootId=Id(root.h); Check(rootId!="missing","fixture root identity"); }
    wchar_t volume[MAX_PATH+1]; Check(GetVolumePathNameW(base.c_str(),volume,MAX_PATH)!=FALSE,"fixture volume");
    Check(GetDriveTypeW(volume)==DRIVE_FIXED,"fixture must be on a local fixed drive");
    SHQUERYRBINFO bin{}; bin.cbSize=sizeof(bin);
    if (FAILED(SHQueryRecycleBinW(volume,&bin))) throw std::runtime_error("Recycle Bin unavailable on fixture volume; no fallback");
    fs::path vault=base/L"vault",outside=base/L"outside",parent=vault/L"parent",note=parent/L"note.md",expectedPath=note;
    fs::create_directories(parent); fs::create_directory(outside); fs::create_directory(base/L"recovered");
    Handle vaultPin(CreateFileW(vault.c_str(),0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    Check(vaultPin.h!=INVALID_HANDLE_VALUE,"vault fixture handle"); const auto vaultIdentity=Id(vaultPin.h); Check(vaultIdentity!="missing","vault fixture identity");
    std::string token=Utf8(name)+" original fixture\n"; File(note,token);
    auto own=[&](const fs::path &path) {
      auto object=Read(path); Check(object.id!="missing" && object.hash!="missing","fixture identity and content");
      owned[object.id]=object.hash; ownedPaths[object.id]=path; return object;
    };
    Row first; first.source=note; first.expected=own(note); rows.push_back(first);
    identityPin.h=CreateFileW(note.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr); Check(identityPin.h!=INVALID_HANDLE_VALUE,"identity pin");
    // An open child can prevent MoveFileEx(directory) even with FILE_SHARE_DELETE.
    // Do not let our diagnostic pin suppress the parent/junction race we intend to test.
    if (mode.find(L"parent-move")!=std::wstring::npos || mode.find(L"junction")!=std::wstring::npos) identityPin.close();
    if (mode==L"same-name" || mode==L"partial") {
      fs::path second=vault/L"other"/L"note.md"; fs::create_directory(second.parent_path()); File(second,token+"second\n");
      Row r; r.source=second; r.expected=own(second); rows.push_back(r);
    }
    if (mode==L"leaf-pin") { leaf.h=CreateFileW(note.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr); Check(leaf.h!=INVALID_HANDLE_VALUE,"leaf deny-delete pin"); }
    if (mode==L"parent-pin-replace") { parentPin.h=CreateFileW(parent.c_str(),0,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr); Check(parentPin.h!=INVALID_HANDLE_VALUE,"parent deny-delete pin"); }
    auto inject=[&]() {
      if (injected) return;
      injected=true;
      if (mode.find(L"file-replace")!=std::wstring::npos || mode==L"parent-pin-replace") {
        fs::path parked=parent/L"parked.md";
        if (!MoveFileExW(note.c_str(),parked.c_str(),0)) { injectionBlocked=true; injectionError=GetLastError(); return; }
        expectedPath=parked; ownedPaths[rows[0].expected.id]=expectedPath;
        File(note,token+"replacement\n"); own(note);
      } else {
        fs::path parked=outside/L"original-parent";
        if (!MoveFileExW(parent.c_str(),parked.c_str(),0)) { injectionBlocked=true; injectionError=GetLastError(); return; }
        expectedPath=parked/L"note.md"; ownedPaths[rows[0].expected.id]=expectedPath;
        if (mode.find(L"junction")!=std::wstring::npos) {
          fs::path trap=outside/L"trap"; fs::create_directory(trap); File(trap/L"note.md",token+"outside sentinel\n"); own(trap/L"note.md");
          Junction(parent,trap);
        } else { fs::create_directory(parent); File(note,token+"replacement parent\n"); own(note); }
      }
    };
    Check(Read(note)==rows[0].expected && InVault(note,vaultIdentity),"initial fixture precheck");
    if (mode.starts_with(L"initial-")) inject();
    auto operation=Operation(flags); std::vector<ComPtr<IShellItem>> sources; std::vector<ComPtr<IFileOperationProgressSink>> sinks;
    for (size_t i=0;i<rows.size();i++) {
      sources.push_back(Item(rows[i].source));
      ComPtr<IFileOperationProgressSink> sink; sink.Attach(new Sink(rows,i,base/L"receipts.jsonl",[&](size_t index,IShellItem *item) {
        auto &row=rows[index]; row.prePath=ItemPath(item);
        row.preIdentity=Read(row.prePath)==row.expected; row.preInVault=InVault(row.prePath,vaultIdentity);
        row.finalCheck=row.preIdentity && row.preInVault;
        if (mode==L"partial" && index==1) return E_ABORT;
        if ((mode.starts_with(L"predelete-") || mode==L"parent-pin-replace") && index==0) {
          if (!rows[index].finalCheck) return E_ABORT;
          try { inject(); } catch (const std::exception &e) { error=e.what(); return E_ABORT; }
        }
        return S_OK;
      }));
      rows[i].queued=operation->DeleteItem(sources.back().Get(),sink.Get()); sinks.push_back(sink);
      if (FAILED(rows[i].queued)) throw std::runtime_error("queue DeleteItem: "+std::to_string(rows[i].queued));
    }
    if (mode.starts_with(L"queued-")) inject();
    perform=operation->PerformOperations();
    abortHr=operation->GetAnyOperationsAborted(&aborted); // Always, even after a failed PerformOperations.
    leaf.close(); parentPin.close(); identityPin.close();
    complete=SUCCEEDED(abortHr) && error.empty(); cleanup=true;
    if ((mode.starts_with(L"predelete-") || mode==L"parent-pin-replace") && !injected) complete=false;
    for (size_t i=0;i<rows.size();i++) {
      auto &r=rows[i]; r.sourceExists=fs::exists(r.source);
      if (r.manifestFailed) complete=false;
      r.owned=r.receipt && owned.contains(r.actual.id) && owned[r.actual.id]==r.actual.hash;
      if (r.receipt) {
        if (!r.owned || !(Read(r.receiptPath)==r.actual)) { cleanup=false; continue; }
        // Reclaim exactly this own Shell receipt, never enumerate or empty the user's Recycle Bin.
        auto recovery=Item(base/L"recovered"); auto restore=Operation(FOF_NOERRORUI|FOFX_EARLYFAILURE|FOF_SILENT);
        std::wstring recovered=L"item-"+std::to_wstring(i)+L".md";
        r.restore=restore->MoveItem(r.receipt.Get(),recovery.Get(),recovered.c_str(),nullptr);
        if (SUCCEEDED(r.restore)) { r.restore=restore->PerformOperations(); r.restoreAbortedHr=restore->GetAnyOperationsAborted(&r.restoreAborted); }
        r.reclaimed=SUCCEEDED(r.restore) && SUCCEEDED(r.restoreAbortedHr) && !r.restoreAborted && Read(base/L"recovered"/recovered)==r.actual;
        if (!r.reclaimed) cleanup=false;
        else ownedPaths[r.actual.id]=base/L"recovered"/recovered;
      } else {
        // No exact receipt plus a missing intended/replacement fixture cannot be reported as completed evidence.
        bool expectedSurvives=Read(i==0?expectedPath:r.source)==r.expected;
        if (!expectedSurvives) { complete=false; cleanup=false; }
        if (r.postCalled && SUCCEEDED(r.post)) { complete=false; cleanup=false; }
      }
    }
    // Every created file, including a replacement/sentinel, must still be present or
    // have been reclaimed through its exact receipt. Missing callbacks are not proof.
    accounted=true;
    for (const auto &[id,hash]:owned) if (!(Read(ownedPaths.at(id))==Object{id,hash})) accounted=false;
    if (!accounted) { complete=false; cleanup=false; error="A fixture object has no verified surviving path or reclaimed receipt"; }
    // Cancelled/blocked outcomes are evidence only if operation callbacks were actually exercised.
    if (rows.empty() || (!rows[0].pre && mode!=L"leaf-pin")) complete=false;
    if (mode==L"ordinary" && (!rows[0].receipt || !rows[0].owned)) complete=false;
    operation.Reset(); sources.clear(); sinks.clear(); for (auto &r:rows) r.receipt.Reset(); vaultPin.close();
    if (cleanup) {
      Handle root(CreateFileW(base.c_str(),0,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
      cleanup=Id(root.h)==rootId; root.close();
      // Explicitly unlink our junction before recursive fixture cleanup, so cleanup never follows it.
      DWORD a=GetFileAttributesW(parent.c_str());
      if (cleanup && a!=INVALID_FILE_ATTRIBUTES && (a&FILE_ATTRIBUTE_REPARSE_POINT)) cleanup=RemoveDirectoryW(parent.c_str())!=FALSE;
      if (cleanup) { std::error_code ec; fs::remove_all(base,ec); cleanup=!ec && !fs::exists(base); }
    }
  } catch (const std::exception &e) { error=e.what(); complete=false; cleanup=false; accounted=false; }
  leaf.close(); parentPin.close(); identityPin.close();
  std::ostringstream out;
  out<<"{\"schemaVersion\":1,\"platform\":\"Windows\",\"mode\":"<<Q(Utf8(mode))<<",\"fixtureRoot\":"<<Q(Utf8(base.native()))<<",\"completed\":"<<B(perform!=E_PENDING)<<",\"experimentComplete\":"<<B(complete)<<",\"performHRESULT\":"<<(long)perform<<",\"getAnyOperationsAbortedHRESULT\":"<<(long)abortHr<<",\"anyOperationsAborted\":"<<B(aborted!=FALSE)<<",\"injected\":"<<B(injected)<<",\"injectionBlocked\":"<<B(injectionBlocked)<<",\"injectionWin32Error\":"<<injectionError<<",\"probeError\":"<<Q(error)<<",\"fixtureReclaimed\":"<<B(cleanup)<<",\"residualFixture\":"<<Q(cleanup?"":Utf8(base.native()))<<",\"systemPutBackVerified\":false,\"cleanupKind\":\"exact-Shell-receipt-MoveItem-to-fixture\",\"items\":[";
  for (size_t i=0;i<rows.size();i++) { auto &r=rows[i]; if (i) out<<','; out<<"{\"source\":"<<Q(Utf8(r.source.native()))<<",\"expected\":"<<Json(r.expected)<<",\"actual\":"<<Json(r.actual)<<",\"queuedHRESULT\":"<<(long)r.queued<<",\"preDeleteCalled\":"<<B(r.pre)<<",\"preDeleteHRESULT\":"<<(long)r.preResult<<",\"finalPrecheckPassed\":"<<B(r.finalCheck)<<",\"postDeleteCalled\":"<<B(r.postCalled)<<",\"postDeleteHRESULT\":"<<(long)r.post<<",\"receipt\":"<<Q(r.receiptName)<<",\"receiptPath\":"<<Q(Utf8(r.receiptPath.native()))<<",\"expectedIdentityAndHash\":"<<B(r.actual==r.expected)<<",\"ownedFixture\":"<<B(r.owned)<<",\"originalExists\":"<<B(r.sourceExists)<<",\"reclaimed\":"<<B(r.reclaimed)<<",\"reclaimHRESULT\":"<<(long)r.restore<<",\"reclaimAbortedHRESULT\":"<<(long)r.restoreAbortedHr<<",\"reclaimAborted\":"<<B(r.restoreAborted!=FALSE)<<'}'; }
  out<<"],\"prechecks\":[";
  for (size_t i=0;i<rows.size();i++) { const auto &r=rows[i]; if (i) out<<','; out<<"{\"path\":"<<Q(Utf8(r.prePath.native()))<<",\"identityAndHash\":"<<B(r.preIdentity)<<",\"inVault\":"<<B(r.preInVault)<<'}'; }
  out<<"],\"ownedFixtureObjectsAccounted\":"<<B(accounted)<<"}"; std::cout<<out.str()<<std::endl;
  for (auto &r:rows) r.receipt.Reset();
  CoUninitialize(); return complete && cleanup ? 0 : 1;
}
