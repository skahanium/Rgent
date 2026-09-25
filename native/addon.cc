#include <node_api.h>

#include <exception>
#include <optional>
#include <stdexcept>
#include <string>

#include "vault_fs.h"

namespace {

void Check(napi_env env, napi_status status) {
  if (status != napi_ok) throw std::runtime_error("NAPI_ERROR");
}

std::string String(napi_env env, napi_value value) {
  size_t length = 0;
  Check(env, napi_get_value_string_utf8(env, value, nullptr, 0, &length));
  std::string out(length + 1, '\0');
  Check(env, napi_get_value_string_utf8(env, value, out.data(), out.size(), &length));
  out.resize(length);
  return out;
}

std::string Bytes(napi_env env, napi_value value) {
  bool is_buffer = false;
  Check(env, napi_is_buffer(env, value, &is_buffer));
  if (!is_buffer) throw std::runtime_error("BAD_BYTES");
  void* data = nullptr;
  size_t length = 0;
  Check(env, napi_get_buffer_info(env, value, &data, &length));
  return std::string(static_cast<const char*>(data), length);
}

napi_value Text(napi_env env, const std::string& value) {
  napi_value out;
  Check(env, napi_create_string_utf8(env, value.data(), value.size(), &out));
  return out;
}

napi_value Number(napi_env env, double value) {
  napi_value out;
  Check(env, napi_create_double(env, value, &out));
  return out;
}

void Set(napi_env env, napi_value object, const char* name, napi_value value) {
  Check(env, napi_set_named_property(env, object, name, value));
}

rgent::VaultHandle* Root(napi_env env, napi_value value) {
  void* pointer = nullptr;
  Check(env, napi_get_value_external(env, value, &pointer));
  auto* root = static_cast<rgent::VaultHandle*>(pointer);
  if (!root || root->closed) throw std::runtime_error("VAULT_CLOSED");
  return root;
}

template <typename Work>
napi_value Invoke(napi_env env, Work&& work) {
  try {
    return work();
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

void FinalizeRoot(napi_env, void* data, void*) {
  auto* root = static_cast<rgent::VaultHandle*>(data);
  rgent::CloseRoot(root);
  delete root;
}

napi_value OpenRoot(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    size_t argc = 1;
    napi_value args[1];
    Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 1) throw std::runtime_error("BAD_ARGS");
    auto* root = rgent::OpenRoot(String(env, args[0]));
    napi_value result;
    const auto status = napi_create_external(env, root, FinalizeRoot, nullptr, &result);
    if (status != napi_ok) { FinalizeRoot(env, root, nullptr); Check(env, status); }
    return result;
  });
}

napi_value CloseRoot(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    size_t argc = 1;
    napi_value args[1];
    Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 1) throw std::runtime_error("BAD_ARGS");
    void* pointer = nullptr;
    Check(env, napi_get_value_external(env, args[0], &pointer));
    rgent::CloseRoot(static_cast<rgent::VaultHandle*>(pointer));
    napi_value result;
    Check(env, napi_get_undefined(env, &result));
    return result;
  });
}

napi_value List(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    size_t argc = 2;
    napi_value args[2];
    Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 2) throw std::runtime_error("BAD_ARGS");
    const auto entries = rgent::List(Root(env, args[0]), String(env, args[1]));
    napi_value result;
    Check(env, napi_create_array_with_length(env, entries.size(), &result));
    for (size_t i = 0; i < entries.size(); ++i) {
      napi_value item;
      Check(env, napi_create_object(env, &item));
      Set(env, item, "name", Text(env, entries[i].name));
      Set(env, item, "kind", Text(env, entries[i].kind));
      Set(env, item, "size", Number(env, static_cast<double>(entries[i].size)));
      Set(env, item, "mtimeMs", Number(env, static_cast<double>(entries[i].mtime_ns) / 1000000.0));
      Check(env, napi_set_element(env, result, i, item));
    }
    return result;
  });
}

napi_value Resolve(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    size_t argc = 2;
    napi_value args[2];
    Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 2) throw std::runtime_error("BAD_ARGS");
    const auto components = rgent::Resolve(Root(env, args[0]), String(env, args[1]));
    napi_value result;
    Check(env, napi_create_array_with_length(env, components.size(), &result));
    for (size_t i = 0; i < components.size(); ++i) {
      napi_value item;
      Check(env, napi_create_object(env, &item));
      Set(env, item, "name", Text(env, components[i].name));
      Set(env, item, "id", Text(env, components[i].id));
      Set(env, item, "kind", Text(env, components[i].kind));
      Check(env, napi_set_element(env, result, i, item));
    }
    return result;
  });
}

napi_value Read(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    size_t argc = 2;
    napi_value args[2];
    Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 2) throw std::runtime_error("BAD_ARGS");
    const auto bytes = rgent::ReadBytes(Root(env, args[0]), String(env, args[1]));
    napi_value result;
    Check(env, napi_create_buffer_copy(env, bytes.size(), bytes.data(), nullptr, &result));
    return result;
  });
}

napi_value Replace(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    size_t argc = 4;
    napi_value args[4];
    Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 4) throw std::runtime_error("BAD_ARGS");
    std::optional<std::string> expected;
    napi_valuetype type;
    Check(env, napi_typeof(env, args[2], &type));
    if (type != napi_null) expected = Bytes(env, args[2]);
    rgent::Replace(Root(env, args[0]), String(env, args[1]), expected, Bytes(env, args[3]));
    napi_value result;
    Check(env, napi_get_undefined(env, &result));
    return result;
  });
}

napi_value Create(napi_env env, napi_callback_info info) {
  return Invoke(env, [&] {
    size_t argc = 2;
    napi_value args[2];
    Check(env, napi_get_cb_info(env, info, &argc, args, nullptr, nullptr));
    if (argc != 2) throw std::runtime_error("BAD_ARGS");
    rgent::Create(Root(env, args[0]), String(env, args[1]));
    napi_value result;
    Check(env, napi_get_undefined(env, &result));
    return result;
  });
}

napi_value Init(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"openRoot", nullptr, OpenRoot, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"closeRoot", nullptr, CloseRoot, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"list", nullptr, List, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"resolve", nullptr, Resolve, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"read", nullptr, Read, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"replace", nullptr, Replace, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"create", nullptr, Create, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  Check(env, napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
