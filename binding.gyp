{
  "targets": [
    {
      "target_name": "rgent_fs",
      "sources": ["native/addon.cc"],
      "conditions": [
        ["OS=='mac'", {"sources": ["native/vault_posix.cc"], "xcode_settings": {"CLANG_CXX_LANGUAGE_STANDARD": "c++17", "GCC_ENABLE_CPP_EXCEPTIONS": "YES"}}],
        ["OS=='win'", {"sources": ["native/vault_win.cc"], "msvs_settings": {"VCCLCompilerTool": {"AdditionalOptions": ["/std:c++17", "/EHsc"]}}}]
      ]
    }
  ]
}
