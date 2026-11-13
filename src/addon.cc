#include <napi.h>

#include <open62541/client.h>
#include <open62541/client_config_default.h>
#include <open62541/client_highlevel.h>
#include <open62541/client_subscriptions.h>
#include <open62541/nodeids.h>

#include <algorithm>
#include <atomic>
#include <charconv>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <exception>
#include <fstream>
#include <functional>
#include <limits>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace {

std::string StatusName(UA_StatusCode status) {
  if (status == UA_STATUSCODE_GOOD) return "Good";
  const char* name = UA_StatusCode_name(status);
  return name ? std::string(name) : "Unknown";
}

std::string UaString(const UA_String& value) {
  return value.data ? std::string(reinterpret_cast<const char*>(value.data), value.length) : "";
}

std::string SecurityPolicyUri(const std::string& policy) {
  if (policy == "None" ||
      policy == "http://opcfoundation.org/UA/SecurityPolicy#None") {
    return "http://opcfoundation.org/UA/SecurityPolicy#None";
  }
  if (policy == "Basic256Sha256" ||
      policy == "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256") {
    return "http://opcfoundation.org/UA/SecurityPolicy#Basic256Sha256";
  }
  if (policy == "Aes128_Sha256_RsaOaep" ||
      policy == "http://opcfoundation.org/UA/SecurityPolicy#Aes128_Sha256_RsaOaep") {
    return "http://opcfoundation.org/UA/SecurityPolicy#Aes128_Sha256_RsaOaep";
  }
  if (policy == "Aes256_Sha256_RsaPss" ||
      policy == "http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss") {
    return "http://opcfoundation.org/UA/SecurityPolicy#Aes256_Sha256_RsaPss";
  }
  return "";
}

UA_MessageSecurityMode SecurityMode(const std::string& mode) {
  if (mode == "None") return UA_MESSAGESECURITYMODE_NONE;
  if (mode == "Sign") return UA_MESSAGESECURITYMODE_SIGN;
  if (mode == "SignAndEncrypt") return UA_MESSAGESECURITYMODE_SIGNANDENCRYPT;
  return UA_MESSAGESECURITYMODE_INVALID;
}

std::string SecurityModeName(UA_MessageSecurityMode mode) {
  if (mode == UA_MESSAGESECURITYMODE_NONE) return "None";
  if (mode == UA_MESSAGESECURITYMODE_SIGN) return "Sign";
  if (mode == UA_MESSAGESECURITYMODE_SIGNANDENCRYPT) return "SignAndEncrypt";
  return "Invalid";
}

bool LoadFile(const std::string& path, UA_ByteString* output, std::string* error) {
  UA_ByteString_init(output);
  std::ifstream stream(path, std::ios::binary | std::ios::ate);
  if (!stream) {
    *error = "Cannot open OPC UA security file: " + path;
    return false;
  }
  const std::streamoff end = stream.tellg();
  if (end <= 0) {
    *error = "OPC UA security file is empty: " + path;
    return false;
  }
  const size_t size = static_cast<size_t>(end);
  if (!UA_StatusCode_isGood(UA_ByteString_allocBuffer(output, size))) {
    *error = "Cannot allocate OPC UA security file buffer for: " + path;
    return false;
  }
  stream.seekg(0, std::ios::beg);
  stream.read(reinterpret_cast<char*>(output->data), static_cast<std::streamsize>(size));
  if (!stream) {
    UA_ByteString_clear(output);
    *error = "Cannot read OPC UA security file: " + path;
    return false;
  }
  return true;
}

void ClearByteStrings(std::vector<UA_ByteString>* values) {
  for (auto& value : *values) UA_ByteString_clear(&value);
  values->clear();
}

bool LoadFiles(const std::vector<std::string>& paths, std::vector<UA_ByteString>* output,
               std::string* error) {
  output->reserve(paths.size());
  for (const auto& path : paths) {
    UA_ByteString value;
    if (!LoadFile(path, &value, error)) {
      ClearByteStrings(output);
      return false;
    }
    output->push_back(value);
  }
  return true;
}

std::string NodeIdString(const UA_NodeId& node_id) {
  UA_String text = UA_STRING_NULL;
  if (!UA_StatusCode_isGood(UA_NodeId_print(&node_id, &text))) return "";
  std::string result = UaString(text);
  UA_String_clear(&text);
  return result;
}

bool ParseNodeId(const std::string& value, UA_NodeId* output) {
  UA_NodeId_init(output);
  UA_String input = UA_STRING(const_cast<char*>(value.c_str()));
  return UA_StatusCode_isGood(UA_NodeId_parse(output, input));
}

std::string QualifiedNameString(const UA_QualifiedName& value) {
  return UaString(value.name);
}

std::string LocalizedTextString(const UA_LocalizedText& value) {
  return UaString(value.text);
}

Napi::Value DateTimeValue(Napi::Env env, UA_DateTime value) {
  constexpr UA_Int64 epoch_offset = 116444736000000000LL;
  return Napi::Date::New(env, static_cast<double>(value - epoch_offset) / 10000.0);
}

const UA_DataType* DataTypeByName(const std::string& name) {
  if (name == "Boolean") return &UA_TYPES[UA_TYPES_BOOLEAN];
  if (name == "SByte") return &UA_TYPES[UA_TYPES_SBYTE];
  if (name == "Byte") return &UA_TYPES[UA_TYPES_BYTE];
  if (name == "Int16") return &UA_TYPES[UA_TYPES_INT16];
  if (name == "UInt16") return &UA_TYPES[UA_TYPES_UINT16];
  if (name == "Int32") return &UA_TYPES[UA_TYPES_INT32];
  if (name == "UInt32") return &UA_TYPES[UA_TYPES_UINT32];
  if (name == "Int64") return &UA_TYPES[UA_TYPES_INT64];
  if (name == "UInt64") return &UA_TYPES[UA_TYPES_UINT64];
  if (name == "Float") return &UA_TYPES[UA_TYPES_FLOAT];
  if (name == "Double") return &UA_TYPES[UA_TYPES_DOUBLE];
  if (name == "String") return &UA_TYPES[UA_TYPES_STRING];
  if (name == "DateTime") return &UA_TYPES[UA_TYPES_DATETIME];
  if (name == "ByteString") return &UA_TYPES[UA_TYPES_BYTESTRING];
  if (name == "LocalizedText") return &UA_TYPES[UA_TYPES_LOCALIZEDTEXT];
  if (name == "QualifiedName") return &UA_TYPES[UA_TYPES_QUALIFIEDNAME];
  return nullptr;
}

std::string DataTypeName(const UA_DataType* type) {
  if (!type) return "Unknown";
  if (type == &UA_TYPES[UA_TYPES_BOOLEAN]) return "Boolean";
  if (type == &UA_TYPES[UA_TYPES_SBYTE]) return "SByte";
  if (type == &UA_TYPES[UA_TYPES_BYTE]) return "Byte";
  if (type == &UA_TYPES[UA_TYPES_INT16]) return "Int16";
  if (type == &UA_TYPES[UA_TYPES_UINT16]) return "UInt16";
  if (type == &UA_TYPES[UA_TYPES_INT32]) return "Int32";
  if (type == &UA_TYPES[UA_TYPES_UINT32]) return "UInt32";
  if (type == &UA_TYPES[UA_TYPES_INT64]) return "Int64";
  if (type == &UA_TYPES[UA_TYPES_UINT64]) return "UInt64";
  if (type == &UA_TYPES[UA_TYPES_FLOAT]) return "Float";
  if (type == &UA_TYPES[UA_TYPES_DOUBLE]) return "Double";
  if (type == &UA_TYPES[UA_TYPES_STRING]) return "String";
  if (type == &UA_TYPES[UA_TYPES_DATETIME]) return "DateTime";
  if (type == &UA_TYPES[UA_TYPES_BYTESTRING]) return "ByteString";
  if (type == &UA_TYPES[UA_TYPES_LOCALIZEDTEXT]) return "LocalizedText";
  if (type == &UA_TYPES[UA_TYPES_QUALIFIEDNAME]) return "QualifiedName";
  return type->typeName ? std::string(type->typeName) : "Unknown";
}

std::string BuiltinTypeName(const UA_NodeId& node_id) {
  if (node_id.namespaceIndex != 0 || node_id.identifierType != UA_NODEIDTYPE_NUMERIC) {
    return NodeIdString(node_id);
  }
  switch (node_id.identifier.numeric) {
    case UA_NS0ID_BOOLEAN: return "Boolean";
    case UA_NS0ID_SBYTE: return "SByte";
    case UA_NS0ID_BYTE: return "Byte";
    case UA_NS0ID_INT16: return "Int16";
    case UA_NS0ID_UINT16: return "UInt16";
    case UA_NS0ID_INT32: return "Int32";
    case UA_NS0ID_UINT32: return "UInt32";
    case UA_NS0ID_INT64: return "Int64";
    case UA_NS0ID_UINT64: return "UInt64";
    case UA_NS0ID_FLOAT: return "Float";
    case UA_NS0ID_DOUBLE: return "Double";
    case UA_NS0ID_STRING: return "String";
    case UA_NS0ID_DATETIME: return "DateTime";
    case UA_NS0ID_BYTESTRING: return "ByteString";
    default: return NodeIdString(node_id);
  }
}

constexpr UA_Int64 kJsSafeInteger = 9007199254740991LL;

Napi::Value Int64Value(Napi::Env env, UA_Int64 value) {
  if (value >= -kJsSafeInteger && value <= kJsSafeInteger) {
    return Napi::Number::New(env, static_cast<double>(value));
  }
  return Napi::String::New(env, std::to_string(value));
}

Napi::Value UInt64Value(Napi::Env env, UA_UInt64 value) {
  if (value <= static_cast<UA_UInt64>(kJsSafeInteger)) {
    return Napi::Number::New(env, static_cast<double>(value));
  }
  return Napi::String::New(env, std::to_string(value));
}

bool InvalidInteger(Napi::Env env, const std::string& name,
                    const std::string& detail) {
  Napi::RangeError::New(env, "Invalid " + name + " value: " + detail)
      .ThrowAsJavaScriptException();
  return false;
}

bool ParseIntegerNumber(Napi::Env env, const Napi::Value& input,
                        const std::string& name, double minimum,
                        double maximum, double* output) {
  if (!input.IsNumber() && !input.IsString()) {
    return InvalidInteger(env, name, "expected an integer number");
  }
  if (input.IsString() && input.As<Napi::String>().Utf8Value().empty()) {
    return InvalidInteger(env, name, "empty string");
  }
  const double value = input.ToNumber().DoubleValue();
  if (!std::isfinite(value) || std::trunc(value) != value ||
      value < minimum || value > maximum) {
    return InvalidInteger(env, name, input.ToString().Utf8Value());
  }
  *output = value;
  return true;
}

bool ParseInt64(Napi::Env env, const Napi::Value& input, UA_Int64* output) {
  if (input.IsBigInt()) {
    bool lossless = false;
    *output = input.As<Napi::BigInt>().Int64Value(&lossless);
    return lossless || InvalidInteger(env, "Int64", "out of range");
  }
  if (input.IsString()) {
    const std::string text = input.As<Napi::String>().Utf8Value();
    const auto result = std::from_chars(
        text.data(), text.data() + text.size(), *output, 10);
    if (!text.empty() && result.ec == std::errc() &&
        result.ptr == text.data() + text.size()) return true;
    return InvalidInteger(env, "Int64", text);
  }
  double value = 0;
  if (!ParseIntegerNumber(env, input, "Int64",
                          -static_cast<double>(kJsSafeInteger),
                          static_cast<double>(kJsSafeInteger), &value)) {
    return false;
  }
  *output = static_cast<UA_Int64>(value);
  return true;
}

bool ParseUInt64(Napi::Env env, const Napi::Value& input, UA_UInt64* output) {
  if (input.IsBigInt()) {
    bool lossless = false;
    *output = input.As<Napi::BigInt>().Uint64Value(&lossless);
    return lossless || InvalidInteger(env, "UInt64", "out of range");
  }
  if (input.IsString()) {
    const std::string text = input.As<Napi::String>().Utf8Value();
    const auto result = std::from_chars(
        text.data(), text.data() + text.size(), *output, 10);
    if (!text.empty() && result.ec == std::errc() &&
        result.ptr == text.data() + text.size()) return true;
    return InvalidInteger(env, "UInt64", text);
  }
  double value = 0;
  if (!ParseIntegerNumber(env, input, "UInt64", 0,
                          static_cast<double>(kJsSafeInteger), &value)) {
    return false;
  }
  *output = static_cast<UA_UInt64>(value);
  return true;
}

Napi::Value VariantValue(Napi::Env env, const UA_Variant* variant) {
  if (!variant || !variant->type || !variant->data) return env.Null();
  const UA_DataType* type = variant->type;

  auto scalar = [&](const void* data) -> Napi::Value {
    if (type == &UA_TYPES[UA_TYPES_BOOLEAN]) return Napi::Boolean::New(env, *static_cast<const UA_Boolean*>(data));
    if (type == &UA_TYPES[UA_TYPES_SBYTE]) return Napi::Number::New(env, *static_cast<const UA_SByte*>(data));
    if (type == &UA_TYPES[UA_TYPES_BYTE]) return Napi::Number::New(env, *static_cast<const UA_Byte*>(data));
    if (type == &UA_TYPES[UA_TYPES_INT16]) return Napi::Number::New(env, *static_cast<const UA_Int16*>(data));
    if (type == &UA_TYPES[UA_TYPES_UINT16]) return Napi::Number::New(env, *static_cast<const UA_UInt16*>(data));
    if (type == &UA_TYPES[UA_TYPES_INT32]) return Napi::Number::New(env, *static_cast<const UA_Int32*>(data));
    if (type == &UA_TYPES[UA_TYPES_UINT32]) return Napi::Number::New(env, *static_cast<const UA_UInt32*>(data));
    if (type == &UA_TYPES[UA_TYPES_INT64]) return Int64Value(env, *static_cast<const UA_Int64*>(data));
    if (type == &UA_TYPES[UA_TYPES_UINT64]) return UInt64Value(env, *static_cast<const UA_UInt64*>(data));
    if (type == &UA_TYPES[UA_TYPES_FLOAT]) return Napi::Number::New(env, *static_cast<const UA_Float*>(data));
    if (type == &UA_TYPES[UA_TYPES_DOUBLE]) return Napi::Number::New(env, *static_cast<const UA_Double*>(data));
    if (type == &UA_TYPES[UA_TYPES_STRING]) return Napi::String::New(env, UaString(*static_cast<const UA_String*>(data)));
    if (type == &UA_TYPES[UA_TYPES_DATETIME]) return DateTimeValue(env, *static_cast<const UA_DateTime*>(data));
    if (type == &UA_TYPES[UA_TYPES_BYTESTRING]) {
      const auto* value = static_cast<const UA_ByteString*>(data);
      return Napi::Buffer<UA_Byte>::Copy(env, value->data, value->length);
    }
    if (type == &UA_TYPES[UA_TYPES_LOCALIZEDTEXT]) {
      const auto* value = static_cast<const UA_LocalizedText*>(data);
      Napi::Object result = Napi::Object::New(env);
      result.Set("locale", UaString(value->locale));
      result.Set("text", UaString(value->text));
      return result;
    }
    if (type == &UA_TYPES[UA_TYPES_QUALIFIEDNAME]) {
      const auto* value = static_cast<const UA_QualifiedName*>(data);
      Napi::Object result = Napi::Object::New(env);
      result.Set("namespaceIndex", value->namespaceIndex);
      result.Set("name", UaString(value->name));
      return result;
    }
    return env.Null();
  };

  if (variant->arrayLength == 0) return scalar(variant->data);
  Napi::Array result = Napi::Array::New(env, variant->arrayLength);
  for (size_t index = 0; index < variant->arrayLength; ++index) {
    result.Set(index, scalar(static_cast<const char*>(variant->data) + index * type->memSize));
  }
  return result;
}

bool JsScalarToVariant(Napi::Env env, const Napi::Value& input, const std::string& name,
                       UA_Variant* output) {
  UA_Variant_init(output);
  const UA_DataType* type = DataTypeByName(name);
  if (!type) {
    Napi::TypeError::New(env, "Unsupported OPC UA data type: " + name).ThrowAsJavaScriptException();
    return false;
  }
  if (name == "Boolean") {
    UA_Boolean value = input.ToBoolean();
    return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type));
  }
  if (name == "SByte") { double parsed; if (!ParseIntegerNumber(env, input, name, -128, 127, &parsed)) return false; UA_SByte value = static_cast<UA_SByte>(parsed); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Byte") { double parsed; if (!ParseIntegerNumber(env, input, name, 0, 255, &parsed)) return false; UA_Byte value = static_cast<UA_Byte>(parsed); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Int16") { double parsed; if (!ParseIntegerNumber(env, input, name, -32768, 32767, &parsed)) return false; UA_Int16 value = static_cast<UA_Int16>(parsed); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "UInt16") { double parsed; if (!ParseIntegerNumber(env, input, name, 0, 65535, &parsed)) return false; UA_UInt16 value = static_cast<UA_UInt16>(parsed); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Int32") { double parsed; if (!ParseIntegerNumber(env, input, name, -2147483648.0, 2147483647.0, &parsed)) return false; UA_Int32 value = static_cast<UA_Int32>(parsed); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "UInt32") { double parsed; if (!ParseIntegerNumber(env, input, name, 0, 4294967295.0, &parsed)) return false; UA_UInt32 value = static_cast<UA_UInt32>(parsed); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Int64") { UA_Int64 value; if (!ParseInt64(env, input, &value)) return false; return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "UInt64") { UA_UInt64 value; if (!ParseUInt64(env, input, &value)) return false; return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Float") { UA_Float value = input.ToNumber().FloatValue(); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Double") { UA_Double value = input.ToNumber().DoubleValue(); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "String") { std::string text = input.ToString().Utf8Value(); UA_String value = UA_STRING(const_cast<char*>(text.c_str())); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "DateTime") { constexpr UA_Int64 offset = 116444736000000000LL; double ms = input.IsDate() ? input.As<Napi::Date>().ValueOf() : input.ToNumber().DoubleValue(); UA_DateTime value = static_cast<UA_DateTime>(ms * 10000.0) + offset; return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "ByteString") {
    if (!input.IsBuffer()) { Napi::TypeError::New(env, "ByteString value must be a Buffer").ThrowAsJavaScriptException(); return false; }
    auto buffer = input.As<Napi::Buffer<UA_Byte>>(); UA_ByteString value{buffer.Length(), buffer.Data()}; return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type));
  }
  return false;
}

bool FlattenJsArray(Napi::Env env, const Napi::Value& input, size_t depth,
                    std::vector<uint32_t>* dimensions,
                    std::vector<Napi::Value>* values, size_t* leaf_depth) {
  if (!input.IsArray()) {
    if (*leaf_depth == std::numeric_limits<size_t>::max()) *leaf_depth = depth;
    if (*leaf_depth != depth) {
      Napi::TypeError::New(env, "OPC UA array value must be rectangular").ThrowAsJavaScriptException();
      return false;
    }
    values->push_back(input);
    return true;
  }
  Napi::Array array = input.As<Napi::Array>();
  if (array.Length() == 0) {
    Napi::TypeError::New(env, "OPC UA array value must not be empty").ThrowAsJavaScriptException();
    return false;
  }
  if (dimensions->size() == depth) dimensions->push_back(array.Length());
  else if ((*dimensions)[depth] != array.Length()) {
    Napi::TypeError::New(env, "OPC UA array value must be rectangular").ThrowAsJavaScriptException();
    return false;
  }
  for (uint32_t index = 0; index < array.Length(); ++index) {
    if (!FlattenJsArray(env, array.Get(index), depth + 1, dimensions, values, leaf_depth)) {
      return false;
    }
  }
  return true;
}

bool JsValueToVariant(Napi::Env env, const Napi::Value& input, const std::string& name,
                      UA_Variant* output) {
  if (!input.IsArray()) return JsScalarToVariant(env, input, name, output);
  const UA_DataType* type = DataTypeByName(name);
  if (!type) {
    Napi::TypeError::New(env, "Unsupported OPC UA data type: " + name).ThrowAsJavaScriptException();
    return false;
  }
  std::vector<uint32_t> dimensions;
  std::vector<Napi::Value> values;
  size_t leaf_depth = std::numeric_limits<size_t>::max();
  if (!FlattenJsArray(env, input, 0, &dimensions, &values, &leaf_depth)) return false;
  void* data = UA_Array_new(values.size(), type);
  if (!data) {
    Napi::Error::New(env, "Failed to allocate OPC UA array value").ThrowAsJavaScriptException();
    return false;
  }
  for (size_t index = 0; index < values.size(); ++index) {
    UA_Variant scalar;
    if (!JsScalarToVariant(env, values[index], name, &scalar)) {
      UA_Variant_clear(&scalar);
      UA_Array_delete(data, values.size(), type);
      return false;
    }
    void* target = static_cast<char*>(data) + index * type->memSize;
    const UA_StatusCode status = UA_copy(scalar.data, target, type);
    UA_Variant_clear(&scalar);
    if (!UA_StatusCode_isGood(status)) {
      UA_Array_delete(data, values.size(), type);
      Napi::Error::New(env, "Failed to copy OPC UA array value").ThrowAsJavaScriptException();
      return false;
    }
  }
  UA_Variant_init(output);
  UA_Variant_setArray(output, data, values.size(), type);
  output->arrayDimensions = static_cast<UA_UInt32*>(
      UA_Array_new(dimensions.size(), &UA_TYPES[UA_TYPES_UINT32]));
  if (!output->arrayDimensions) {
    UA_Variant_clear(output);
    Napi::Error::New(env, "Failed to allocate OPC UA array dimensions").ThrowAsJavaScriptException();
    return false;
  }
  output->arrayDimensionsSize = dimensions.size();
  std::copy(dimensions.begin(), dimensions.end(), output->arrayDimensions);
  return true;
}

std::string GetString(const Napi::Object& object, const char* name, const std::string& fallback = "") {
  if (!object.Has(name)) return fallback;
  Napi::Value value = object.Get(name);
  return value.IsString() ? value.As<Napi::String>().Utf8Value() : fallback;
}

double GetDouble(const Napi::Object& object, const char* name, double fallback) {
  if (!object.Has(name)) return fallback;
  Napi::Value value = object.Get(name);
  return value.IsNumber() ? value.As<Napi::Number>().DoubleValue() : fallback;
}

uint32_t GetUInt(const Napi::Object& object, const char* name, uint32_t fallback) {
  double value = GetDouble(object, name, fallback);
  return value >= 0 ? static_cast<uint32_t>(value) : fallback;
}

bool GetBool(const Napi::Object& object, const char* name, bool fallback) {
  if (!object.Has(name)) return fallback;
  Napi::Value value = object.Get(name);
  return value.IsBoolean() ? value.As<Napi::Boolean>().Value() : fallback;
}

struct RawChange {
  uint32_t monitored_item_id = 0;
  uint32_t client_handle = 0;
  std::string node_id;
  UA_DataValue value;
  std::chrono::steady_clock::time_point enqueued_at;
  RawChange() : enqueued_at(std::chrono::steady_clock::now()) { UA_DataValue_init(&value); }
  ~RawChange() { UA_DataValue_clear(&value); }
};

struct NotificationQueue {
  Napi::ThreadSafeFunction callback;
  std::mutex mutex;
  std::deque<std::unique_ptr<RawChange>> fifo;
  std::unordered_map<uint32_t, std::unique_ptr<RawChange>> latest;
  std::deque<uint32_t> latest_order;
  size_t capacity = 10000;
  size_t batch_size = 500;
  std::string mode = "all";
  std::string overflow_policy = "drop-oldest";
  std::atomic<bool> scheduled{false};
  std::atomic<bool> closing{false};
  std::atomic<bool> released{false};
  std::atomic<uint64_t> enqueued{0};
  std::atomic<uint64_t> delivered{0};
  std::atomic<uint64_t> dropped{0};
  std::atomic<uint64_t> coalesced{0};
  std::atomic<uint64_t> batches{0};
  size_t max_depth = 0;
};

struct SubscriptionContext;

struct MonitoredContext {
  std::shared_ptr<NotificationQueue> notifications;
  std::string node_id;
  uint32_t monitored_item_id = 0;
  uint32_t client_handle = 0;
};

struct SubscriptionContext {
  uint32_t subscription_id = 0;
  std::shared_ptr<NotificationQueue> notifications;
  std::map<uint32_t, std::unique_ptr<MonitoredContext>> monitored;
  std::unordered_map<uint32_t, MonitoredContext*> monitored_by_client_handle;
  uint32_t next_client_handle = 1;
};

struct OperationLimits {
  std::atomic<uint32_t> max_nodes_per_read{0};
  std::atomic<uint32_t> max_nodes_per_write{0};
  std::atomic<uint32_t> max_nodes_per_browse{0};
  std::atomic<uint32_t> max_monitored_items_per_call{0};
  std::atomic<uint32_t> max_monitored_items_per_subscription{0};
};

struct CachedNodeId {
  UA_NodeId value;
  CachedNodeId() { UA_NodeId_init(&value); }
  ~CachedNodeId() { UA_NodeId_clear(&value); }
  CachedNodeId(const CachedNodeId&) = delete;
  CachedNodeId& operator=(const CachedNodeId&) = delete;
};

struct ClientCommand {
  std::function<void()> execute;
  std::mutex completion_mutex;
  std::condition_variable completion_cv;
  bool completed = false;
  std::string rejection;
};

struct ClientContext {
  UA_Client* client = nullptr;
  std::string endpoint;
  std::string security_mode;
  std::string security_policy_uri;
  std::string identity_type;
  std::string private_key_password;
  std::atomic<bool> running{false};
  std::thread iterate_thread;
  std::mutex command_mutex;
  std::condition_variable command_cv;
  std::deque<std::shared_ptr<ClientCommand>> commands;
  size_t command_queue_capacity = 256;
  uint32_t command_queue_timeout_ms = 10000;
  size_t command_queue_max_depth = 0;
  std::atomic<uint64_t> commands_enqueued{0};
  std::atomic<uint64_t> commands_completed{0};
  std::atomic<uint64_t> commands_rejected{0};
  std::atomic<uint64_t> commands_timed_out{0};
  std::atomic<uint32_t> commands_active{0};
  std::map<uint32_t, std::unique_ptr<SubscriptionContext>> subscriptions;
  OperationLimits operation_limits;
  std::mutex node_id_cache_mutex;
  std::unordered_map<std::string, std::unique_ptr<CachedNodeId>> node_id_cache;
  std::deque<std::string> node_id_cache_order;
  size_t node_id_cache_capacity = 100000;
  std::atomic<uint64_t> node_id_cache_hits{0};
  std::atomic<uint64_t> node_id_cache_misses{0};
  std::atomic<uint64_t> node_id_cache_bypasses{0};
  std::atomic<uint64_t> node_id_cache_evictions{0};
  Napi::ThreadSafeFunction state_callback;
  std::atomic<bool> has_state_callback{false};
  std::atomic<bool> state_callback_released{false};
  std::atomic<uint32_t> channel_state{UA_SECURECHANNELSTATE_CLOSED};
  std::atomic<uint32_t> session_state{UA_SESSIONSTATE_CLOSED};
  std::atomic<uint32_t> connect_status{UA_STATUSCODE_GOOD};
  std::atomic<bool> connected{false};
  std::atomic<bool> ever_connected{false};
  std::atomic<bool> force_secure_channel_reconnect{false};
  std::atomic<bool> refresh_operation_limits{false};
  std::atomic<uint64_t> state_sequence{0};
  std::atomic<uint64_t> reconnect_count{0};
  std::atomic<uint64_t> disconnect_count{0};
  std::atomic<uint64_t> session_generation{0};
};

#ifdef UA_ENABLE_ENCRYPTION
UA_StatusCode PrivateKeyPasswordCallback(UA_ClientConfig* config, UA_ByteString* password) {
  auto* context = static_cast<ClientContext*>(config ? config->clientContext : nullptr);
  if (!context || context->private_key_password.empty()) {
    return UA_STATUSCODE_BADSECURITYCHECKSFAILED;
  }
  *password = UA_BYTESTRING_ALLOC(context->private_key_password.c_str());
  return password->length == context->private_key_password.size()
    ? UA_STATUSCODE_GOOD : UA_STATUSCODE_BADOUTOFMEMORY;
}
#endif

struct ClientStateEvent {
  std::string state;
  std::string reason;
  uint32_t channel_state = UA_SECURECHANNELSTATE_CLOSED;
  uint32_t session_state = UA_SESSIONSTATE_CLOSED;
  UA_StatusCode status = UA_STATUSCODE_GOOD;
  uint32_t subscription_id = 0;
  uint64_t sequence = 0;
  uint64_t reconnect_count = 0;
  uint64_t session_generation = 0;
};

const char* ChannelStateName(uint32_t state) {
  switch (state) {
    case UA_SECURECHANNELSTATE_CLOSED: return "Closed";
    case UA_SECURECHANNELSTATE_REVERSE_LISTENING: return "ReverseListening";
    case UA_SECURECHANNELSTATE_CONNECTING: return "Connecting";
    case UA_SECURECHANNELSTATE_CONNECTED: return "Connected";
    case UA_SECURECHANNELSTATE_REVERSE_CONNECTED: return "ReverseConnected";
    case UA_SECURECHANNELSTATE_RHE_SENT: return "ReverseHelloSent";
    case UA_SECURECHANNELSTATE_HEL_SENT: return "HelloSent";
    case UA_SECURECHANNELSTATE_HEL_RECEIVED: return "HelloReceived";
    case UA_SECURECHANNELSTATE_ACK_SENT: return "AcknowledgeSent";
    case UA_SECURECHANNELSTATE_ACK_RECEIVED: return "AcknowledgeReceived";
    case UA_SECURECHANNELSTATE_OPN_SENT: return "OpenSent";
    case UA_SECURECHANNELSTATE_OPEN: return "Open";
    case UA_SECURECHANNELSTATE_CLOSING: return "Closing";
    default: return "Unknown";
  }
}

const char* SessionStateName(uint32_t state) {
  switch (state) {
    case UA_SESSIONSTATE_CLOSED: return "Closed";
    case UA_SESSIONSTATE_CREATE_REQUESTED: return "CreateRequested";
    case UA_SESSIONSTATE_CREATED: return "Created";
    case UA_SESSIONSTATE_ACTIVATE_REQUESTED: return "ActivateRequested";
    case UA_SESSIONSTATE_ACTIVATED: return "Activated";
    case UA_SESSIONSTATE_CLOSING: return "Closing";
    default: return "Unknown";
  }
}

void QueueStateEvent(ClientContext* context, std::unique_ptr<ClientStateEvent> event) {
  if (!context || !context->has_state_callback.load() ||
      context->state_callback_released.load()) return;
  auto* raw = event.release();
  napi_status queued = context->state_callback.NonBlockingCall(
      raw, [](Napi::Env env, Napi::Function callback, ClientStateEvent* data) {
        std::unique_ptr<ClientStateEvent> event(data);
        Napi::Object value = Napi::Object::New(env);
        value.Set("state", event->state);
        value.Set("reason", event->reason);
        value.Set("connected", event->state == "connected");
        value.Set("recoverable", UA_StatusCode_isGood(event->status));
        value.Set("terminal", !UA_StatusCode_isGood(event->status));
        value.Set("statusCode", StatusName(event->status));
        value.Set("channelState", ChannelStateName(event->channel_state));
        value.Set("sessionState", SessionStateName(event->session_state));
        value.Set("sequence", Napi::Number::New(env, static_cast<double>(event->sequence)));
        value.Set("reconnectCount", Napi::Number::New(env, static_cast<double>(event->reconnect_count)));
        value.Set("sessionGeneration", Napi::Number::New(env, static_cast<double>(event->session_generation)));
        if (event->subscription_id) value.Set("subscriptionId", event->subscription_id);
        callback.Call({value});
      });
  if (queued != napi_ok) delete raw;
}

void ClientStateChanged(UA_Client* client, UA_SecureChannelState channel_state,
                        UA_SessionState session_state, UA_StatusCode connect_status) {
  auto* context = static_cast<ClientContext*>(UA_Client_getContext(client));
  if (!context) return;
  context->channel_state.store(channel_state);
  context->session_state.store(session_state);
  context->connect_status.store(connect_status);
  bool now_connected = channel_state == UA_SECURECHANNELSTATE_OPEN &&
                       session_state == UA_SESSIONSTATE_ACTIVATED &&
                       UA_StatusCode_isGood(connect_status);
  bool was_connected = context->connected.exchange(now_connected);
  if (was_connected && !now_connected) context->disconnect_count.fetch_add(1);
  if (now_connected && !was_connected) {
    bool was_ever_connected = context->ever_connected.exchange(true);
    if (was_ever_connected) context->reconnect_count.fetch_add(1);
    context->session_generation.fetch_add(1);
    context->refresh_operation_limits.store(true);
  }
  auto event = std::make_unique<ClientStateEvent>();
  event->state = now_connected ? "connected" :
      (UA_StatusCode_isGood(connect_status) ? "reconnecting" : "failed");
  event->reason = now_connected ? (was_connected ? "state" : "session-activated") :
      (UA_StatusCode_isGood(connect_status) ? "transport-or-session" : "terminal");
  event->channel_state = channel_state;
  event->session_state = session_state;
  event->status = connect_status;
  event->sequence = context->state_sequence.fetch_add(1) + 1;
  event->reconnect_count = context->reconnect_count.load();
  event->session_generation = context->session_generation.load();
  QueueStateEvent(context, std::move(event));
}

void ClientInactivity(UA_Client* client) {
  auto* context = static_cast<ClientContext*>(UA_Client_getContext(client));
  if (!context) return;
  context->force_secure_channel_reconnect.store(true);
  auto event = std::make_unique<ClientStateEvent>();
  event->state = "reconnecting";
  event->reason = "connectivity-inactive";
  event->channel_state = context->channel_state.load();
  event->session_state = context->session_state.load();
  event->sequence = context->state_sequence.fetch_add(1) + 1;
  event->reconnect_count = context->reconnect_count.load();
  event->session_generation = context->session_generation.load();
  QueueStateEvent(context, std::move(event));
}

void SubscriptionInactivity(UA_Client* client, UA_UInt32 subscription_id, void*) {
  auto* context = static_cast<ClientContext*>(UA_Client_getContext(client));
  if (!context) return;
  context->force_secure_channel_reconnect.store(true);
  auto event = std::make_unique<ClientStateEvent>();
  event->state = "subscription-inactive";
  event->reason = "publish-timeout";
  event->channel_state = context->channel_state.load();
  event->session_state = context->session_state.load();
  event->subscription_id = subscription_id;
  event->sequence = context->state_sequence.fetch_add(1) + 1;
  event->reconnect_count = context->reconnect_count.load();
  event->session_generation = context->session_generation.load();
  QueueStateEvent(context, std::move(event));
}

bool CopyCachedNodeId(ClientContext* context, const std::string& text, UA_NodeId* output) {
  if (!context || context->node_id_cache_capacity == 0) {
    if (context) context->node_id_cache_bypasses.fetch_add(1);
    return ParseNodeId(text, output);
  }
  std::lock_guard<std::mutex> lock(context->node_id_cache_mutex);
  auto found = context->node_id_cache.find(text);
  if (found != context->node_id_cache.end()) {
    context->node_id_cache_hits.fetch_add(1);
    return UA_StatusCode_isGood(UA_NodeId_copy(&found->second->value, output));
  }
  context->node_id_cache_misses.fetch_add(1);
  auto parsed = std::make_unique<CachedNodeId>();
  if (!ParseNodeId(text, &parsed->value)) return false;
  if (context->node_id_cache.size() >= context->node_id_cache_capacity) {
    context->node_id_cache.erase(context->node_id_cache_order.front());
    context->node_id_cache_order.pop_front();
    context->node_id_cache_evictions.fetch_add(1);
  }
  bool copied = UA_StatusCode_isGood(UA_NodeId_copy(&parsed->value, output));
  if (copied) {
    context->node_id_cache.emplace(text, std::move(parsed));
    context->node_id_cache_order.push_back(text);
  }
  return copied;
}

void ReadOperationLimits(ClientContext* context) {
  constexpr size_t count = 5;
  const UA_UInt32 node_ids[count] = {
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXNODESPERREAD,
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXNODESPERWRITE,
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXNODESPERBROWSE,
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXMONITOREDITEMSPERCALL,
      24104};  // Server.ServerCapabilities.MaxMonitoredItemsPerSubscription
  uint32_t values[count] = {};
  UA_ReadRequest request;
  UA_ReadRequest_init(&request);
  request.timestampsToReturn = UA_TIMESTAMPSTORETURN_NEITHER;
  request.nodesToReadSize = count;
  request.nodesToRead = static_cast<UA_ReadValueId*>(
      UA_Array_new(count, &UA_TYPES[UA_TYPES_READVALUEID]));
  if (!request.nodesToRead) return;
  for (size_t index = 0; index < count; ++index) {
    request.nodesToRead[index].nodeId = UA_NODEID_NUMERIC(0, node_ids[index]);
    request.nodesToRead[index].attributeId = UA_ATTRIBUTEID_VALUE;
  }
  UA_ReadResponse response = UA_Client_Service_read(context->client, request);
  UA_ReadRequest_clear(&request);
  if (UA_StatusCode_isGood(response.responseHeader.serviceResult)) {
    for (size_t index = 0; index < count && index < response.resultsSize; ++index) {
      const UA_DataValue& value = response.results[index];
      if (value.hasValue && UA_Variant_isScalar(&value.value) &&
          value.value.type == &UA_TYPES[UA_TYPES_UINT32] && value.value.data) {
        values[index] = *static_cast<UA_UInt32*>(value.value.data);
      }
    }
  }
  UA_ReadResponse_clear(&response);
  context->operation_limits.max_nodes_per_read.store(values[0]);
  context->operation_limits.max_nodes_per_write.store(values[1]);
  context->operation_limits.max_nodes_per_browse.store(values[2]);
  context->operation_limits.max_monitored_items_per_call.store(values[3]);
  context->operation_limits.max_monitored_items_per_subscription.store(values[4]);
}

std::mutex clients_mutex;
std::map<uint64_t, std::shared_ptr<ClientContext>> clients;
std::atomic<uint64_t> next_client_id{1};

std::shared_ptr<ClientContext> FindClient(uint64_t client_id) {
  std::lock_guard<std::mutex> lock(clients_mutex);
  auto found = clients.find(client_id);
  return found == clients.end() ? nullptr : found->second;
}

void CloseNotificationQueue(const std::shared_ptr<NotificationQueue>& queue);

void CompleteClientCommand(const std::shared_ptr<ClientCommand>& command,
                           std::string rejection = {}) {
  {
    std::lock_guard<std::mutex> lock(command->completion_mutex);
    command->rejection = std::move(rejection);
    command->completed = true;
  }
  command->completion_cv.notify_one();
}

std::string RunClientCommand(const std::shared_ptr<ClientContext>& context,
                             std::function<void()> execute) {
  auto command = std::make_shared<ClientCommand>();
  command->execute = std::move(execute);
  {
    std::lock_guard<std::mutex> lock(context->command_mutex);
    if (!context->running.load()) {
      context->commands_rejected.fetch_add(1);
      return "OPC UA client is closing";
    }
    if (context->commands.size() >= context->command_queue_capacity) {
      context->commands_rejected.fetch_add(1);
      return "OPC UA client command queue is full";
    }
    context->commands.push_back(command);
    context->commands_enqueued.fetch_add(1);
    context->command_queue_max_depth =
        std::max(context->command_queue_max_depth, context->commands.size());
  }
  context->command_cv.notify_one();

  std::unique_lock<std::mutex> lock(command->completion_mutex);
  if (!command->completion_cv.wait_for(
          lock, std::chrono::milliseconds(context->command_queue_timeout_ms),
          [&] { return command->completed; })) {
    lock.unlock();
    bool removed = false;
    {
      std::lock_guard<std::mutex> queue_lock(context->command_mutex);
      auto found = std::find(context->commands.begin(), context->commands.end(), command);
      if (found != context->commands.end()) {
        context->commands.erase(found);
        removed = true;
      }
    }
    if (removed) {
      context->commands_rejected.fetch_add(1);
      context->commands_timed_out.fetch_add(1);
      CompleteClientCommand(command, "OPC UA client command timed out while queued");
    }
    lock.lock();
    command->completion_cv.wait(lock, [&] { return command->completed; });
  }
  return command->rejection;
}

void RejectPendingClientCommands(ClientContext* context, const std::string& reason) {
  std::deque<std::shared_ptr<ClientCommand>> pending;
  {
    std::lock_guard<std::mutex> lock(context->command_mutex);
    pending.swap(context->commands);
  }
  context->commands_rejected.fetch_add(pending.size());
  for (auto& command : pending) CompleteClientCommand(command, reason);
}

void DrainClientCommands(ClientContext* context, size_t maximum) {
  for (size_t index = 0; index < maximum; ++index) {
    std::shared_ptr<ClientCommand> command;
    {
      std::lock_guard<std::mutex> lock(context->command_mutex);
      if (context->commands.empty()) return;
      command = std::move(context->commands.front());
      context->commands.pop_front();
    }
    context->commands_active.store(1);
    try {
      command->execute();
      context->commands_active.store(0);
      context->commands_completed.fetch_add(1);
      CompleteClientCommand(command);
    } catch (const std::exception& error) {
      context->commands_active.store(0);
      context->commands_rejected.fetch_add(1);
      CompleteClientCommand(command, std::string("OPC UA client command failed: ") + error.what());
    } catch (...) {
      context->commands_active.store(0);
      context->commands_rejected.fetch_add(1);
      CompleteClientCommand(command, "OPC UA client command failed unexpectedly");
    }
    if (!context->running.load()) return;
  }
}

void Iterate(ClientContext* context) {
  while (context->running.load()) {
    DrainClientCommands(context, 32);
    if (context->client) {
      UA_Client_run_iterate(context->client, 20);
      if (context->force_secure_channel_reconnect.exchange(false)) {
        UA_Client_disconnectSecureChannelAsync(context->client);
      }
      if (context->refresh_operation_limits.exchange(false) &&
          context->session_state.load() == UA_SESSIONSTATE_ACTIVATED) {
        ReadOperationLimits(context);
      }
    }
    std::unique_lock<std::mutex> lock(context->command_mutex);
    if (context->commands.empty() && context->running.load()) {
      context->command_cv.wait_for(lock, std::chrono::milliseconds(5));
    }
  }
  RejectPendingClientCommands(context, "OPC UA client is closing");
  for (auto& entry : context->subscriptions) CloseNotificationQueue(entry.second->notifications);
  context->subscriptions.clear();
  if (context->client) {
    UA_Client_disconnect(context->client);
    UA_Client_delete(context->client);
    context->client = nullptr;
  }
}

void CloseNotificationQueue(const std::shared_ptr<NotificationQueue>& queue) {
  if (!queue || queue->released.exchange(true)) return;
  queue->closing.store(true);
  queue->callback.Release();
}

void CloseClient(uint64_t client_id) {
  std::shared_ptr<ClientContext> context;
  {
    std::lock_guard<std::mutex> lock(clients_mutex);
    auto found = clients.find(client_id);
    if (found == clients.end()) return;
    context = found->second;
    clients.erase(found);
  }
  const std::string shutdown_rejection = RunClientCommand(
      context, [context] { context->running.store(false); });
  if (!shutdown_rejection.empty()) context->running.store(false);
  context->command_cv.notify_all();
  if (context->iterate_thread.joinable()) context->iterate_thread.join();
  if (context->has_state_callback.load() &&
      !context->state_callback_released.exchange(true)) {
    context->state_callback.Release();
  }
}

struct DrainRequest { std::shared_ptr<NotificationQueue> queue; };

size_t NotificationQueueDepthLocked(const NotificationQueue& queue) {
  return queue.mode == "latest" ? queue.latest.size() : queue.fifo.size();
}

void ScheduleNotificationDrain(const std::shared_ptr<NotificationQueue>& queue);

void DrainNotifications(Napi::Env env, Napi::Function callback, DrainRequest* request) {
  auto queue = request->queue;
  delete request;
  std::vector<std::unique_ptr<RawChange>> changes;
  size_t queue_depth = 0;
  size_t max_queue_depth = 0;
  double max_lag_ms = 0;
  {
    std::lock_guard<std::mutex> lock(queue->mutex);
    const size_t count = std::min(queue->batch_size, NotificationQueueDepthLocked(*queue));
    changes.reserve(count);
    for (size_t index = 0; index < count; ++index) {
      std::unique_ptr<RawChange> change;
      if (queue->mode == "latest") {
        const uint32_t monitored_item_id = queue->latest_order.front();
        queue->latest_order.pop_front();
        auto found = queue->latest.find(monitored_item_id);
        if (found != queue->latest.end()) {
          change = std::move(found->second);
          queue->latest.erase(found);
        }
      } else {
        change = std::move(queue->fifo.front());
        queue->fifo.pop_front();
      }
      if (change) {
        const auto lag = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - change->enqueued_at).count();
        max_lag_ms = std::max(max_lag_ms, lag);
        changes.push_back(std::move(change));
      }
    }
    queue_depth = NotificationQueueDepthLocked(*queue);
    max_queue_depth = queue->max_depth;
    queue->scheduled.store(false);
  }

  queue->delivered.fetch_add(changes.size());
  const uint64_t batch_sequence = queue->batches.fetch_add(1) + 1;
  if (queue_depth > 0 && !queue->closing.load()) ScheduleNotificationDrain(queue);

  Napi::Array output = Napi::Array::New(env, changes.size());
  for (size_t index = 0; index < changes.size(); ++index) {
    RawChange* data = changes[index].get();
    Napi::Object result = Napi::Object::New(env);
    result.Set("nodeId", data->node_id);
    result.Set("monitoredItemId", data->monitored_item_id);
    result.Set("clientHandle", data->client_handle);
    result.Set("statusCode", StatusName(data->value.status));
    if (data->value.hasValue) {
      result.Set("value", VariantValue(env, &data->value.value));
      result.Set("dataType", DataTypeName(data->value.value.type));
    }
    if (data->value.hasSourceTimestamp) result.Set("sourceTimestamp", DateTimeValue(env, data->value.sourceTimestamp));
    if (data->value.hasServerTimestamp) result.Set("serverTimestamp", DateTimeValue(env, data->value.serverTimestamp));
    output.Set(index, result);
  }
  Napi::Object diagnostics = Napi::Object::New(env);
  diagnostics.Set("queueDepth", Napi::Number::New(env, static_cast<double>(queue_depth)));
  diagnostics.Set("queueCapacity", Napi::Number::New(env, static_cast<double>(queue->capacity)));
  diagnostics.Set("maxQueueDepth", Napi::Number::New(env, static_cast<double>(max_queue_depth)));
  diagnostics.Set("enqueued", Napi::Number::New(env, static_cast<double>(queue->enqueued.load())));
  diagnostics.Set("delivered", Napi::Number::New(env, static_cast<double>(queue->delivered.load())));
  diagnostics.Set("dropped", Napi::Number::New(env, static_cast<double>(queue->dropped.load())));
  diagnostics.Set("coalesced", Napi::Number::New(env, static_cast<double>(queue->coalesced.load())));
  diagnostics.Set("batchSequence", Napi::Number::New(env, static_cast<double>(batch_sequence)));
  diagnostics.Set("batchSize", Napi::Number::New(env, static_cast<double>(changes.size())));
  diagnostics.Set("maxLagMs", Napi::Number::New(env, max_lag_ms));
  diagnostics.Set("mode", queue->mode);
  diagnostics.Set("overflowPolicy", queue->overflow_policy);
  Napi::Object batch = Napi::Object::New(env);
  batch.Set("changes", output);
  batch.Set("diagnostics", diagnostics);
  callback.Call({batch});
}

void ScheduleNotificationDrain(const std::shared_ptr<NotificationQueue>& queue) {
  if (!queue || queue->closing.load() || queue->scheduled.exchange(true)) return;
  auto* request = new DrainRequest{queue};
  const napi_status status = queue->callback.NonBlockingCall(request, DrainNotifications);
  if (status != napi_ok) {
    queue->scheduled.store(false);
    delete request;
  }
}

void EnqueueNotification(const std::shared_ptr<NotificationQueue>& queue,
                         std::unique_ptr<RawChange> change) {
  if (!queue || queue->closing.load()) return;
  bool accepted = true;
  {
    std::lock_guard<std::mutex> lock(queue->mutex);
    if (queue->mode == "latest") {
      auto found = queue->latest.find(change->monitored_item_id);
      if (found != queue->latest.end()) {
        found->second = std::move(change);
        queue->coalesced.fetch_add(1);
      } else {
        if (queue->latest.size() >= queue->capacity) {
          if (queue->overflow_policy == "drop-newest") {
            queue->dropped.fetch_add(1);
            accepted = false;
          } else {
            const uint32_t oldest = queue->latest_order.front();
            queue->latest_order.pop_front();
            queue->latest.erase(oldest);
            queue->dropped.fetch_add(1);
          }
        }
        if (accepted) {
          queue->latest_order.push_back(change->monitored_item_id);
          queue->latest.emplace(change->monitored_item_id, std::move(change));
        }
      }
    } else {
      if (queue->fifo.size() >= queue->capacity) {
        if (queue->overflow_policy == "drop-newest") {
          queue->dropped.fetch_add(1);
          accepted = false;
        } else {
          queue->fifo.pop_front();
          queue->dropped.fetch_add(1);
        }
      }
      if (accepted) queue->fifo.push_back(std::move(change));
    }
    if (accepted) queue->enqueued.fetch_add(1);
    queue->max_depth = std::max(queue->max_depth, NotificationQueueDepthLocked(*queue));
  }
  ScheduleNotificationDrain(queue);
}

void DataChange(UA_Client*, UA_UInt32, void*, UA_UInt32 monitored_item_id,
                void* monitored_context, UA_DataValue* value) {
  auto* monitored = static_cast<MonitoredContext*>(monitored_context);
  if (!monitored || !monitored->notifications || !value) return;
  auto change = std::make_unique<RawChange>();
  change->monitored_item_id = monitored_item_id;
  change->client_handle = monitored->client_handle;
  change->node_id = monitored->node_id;
  UA_DataValue_copy(value, &change->value);
  EnqueueNotification(monitored->notifications, std::move(change));
}

class PromiseWorker : public Napi::AsyncWorker {
 public:
  explicit PromiseWorker(Napi::Promise::Deferred deferred)
      : Napi::AsyncWorker(deferred.Env()), deferred_(deferred) {}
  void OnError(const Napi::Error& error) override { deferred_.Reject(error.Value()); }
 protected:
  Napi::Promise::Deferred deferred_;
};

std::string UserTokenTypeName(UA_UserTokenType type) {
  if (type == UA_USERTOKENTYPE_ANONYMOUS) return "Anonymous";
  if (type == UA_USERTOKENTYPE_USERNAME) return "Username";
  if (type == UA_USERTOKENTYPE_CERTIFICATE) return "Certificate";
  if (type == UA_USERTOKENTYPE_ISSUEDTOKEN) return "IssuedToken";
  return "Unknown";
}

struct DiscoveredUserToken {
  std::string policy_id;
  std::string token_type;
  std::string security_policy_uri;
  std::string issued_token_type;
  std::string issuer_endpoint_url;
};

struct DiscoveredEndpoint {
  std::string endpoint_url;
  std::string security_mode;
  std::string security_policy_uri;
  std::string server_application_uri;
  std::string product_uri;
  uint8_t security_level = 0;
  std::vector<DiscoveredUserToken> user_identity_tokens;
};

class DiscoverEndpointsWorker : public PromiseWorker {
 public:
  DiscoverEndpointsWorker(Napi::Promise::Deferred deferred, std::string endpoint,
                          uint32_t timeout)
      : PromiseWorker(deferred), endpoint_(std::move(endpoint)), timeout_(timeout) {}

  void Execute() override {
    if (endpoint_.empty()) { SetError("OPC UA endpoint is required"); return; }
    UA_Client* client = UA_Client_new();
    if (!client) { SetError("Failed to create open62541 discovery client"); return; }
    UA_ClientConfig* config = UA_Client_getConfig(client);
    config->timeout = timeout_;
    size_t endpoint_count = 0;
    UA_EndpointDescription* endpoints = nullptr;
    const UA_StatusCode status = UA_Client_getEndpoints(
        client, endpoint_.c_str(), &endpoint_count, &endpoints);
    if (UA_StatusCode_isGood(status)) {
      endpoints_.reserve(endpoint_count);
      for (size_t index = 0; index < endpoint_count; ++index) {
        const UA_EndpointDescription& source = endpoints[index];
        DiscoveredEndpoint target;
        target.endpoint_url = UaString(source.endpointUrl);
        target.security_mode = SecurityModeName(source.securityMode);
        target.security_policy_uri = UaString(source.securityPolicyUri);
        target.server_application_uri = UaString(source.server.applicationUri);
        target.product_uri = UaString(source.server.productUri);
        target.security_level = source.securityLevel;
        target.user_identity_tokens.reserve(source.userIdentityTokensSize);
        for (size_t token_index = 0; token_index < source.userIdentityTokensSize;
             ++token_index) {
          const UA_UserTokenPolicy& token = source.userIdentityTokens[token_index];
          target.user_identity_tokens.push_back({
            UaString(token.policyId),
            UserTokenTypeName(token.tokenType),
            UaString(token.securityPolicyUri),
            UaString(token.issuedTokenType),
            UaString(token.issuerEndpointUrl),
          });
        }
        endpoints_.push_back(std::move(target));
      }
    }
    if (endpoints) {
      UA_Array_delete(endpoints, endpoint_count, &UA_TYPES[UA_TYPES_ENDPOINTDESCRIPTION]);
    }
    UA_Client_delete(client);
    if (!UA_StatusCode_isGood(status)) {
      SetError("GetEndpoints failed: " + StatusName(status));
    }
  }

  void OnOK() override {
    Napi::Array output = Napi::Array::New(Env(), endpoints_.size());
    for (size_t index = 0; index < endpoints_.size(); ++index) {
      const auto& endpoint = endpoints_[index];
      Napi::Object value = Napi::Object::New(Env());
      value.Set("endpointUrl", endpoint.endpoint_url);
      value.Set("securityMode", endpoint.security_mode);
      value.Set("securityPolicyUri", endpoint.security_policy_uri);
      value.Set("securityLevel", endpoint.security_level);
      value.Set("serverApplicationUri", endpoint.server_application_uri);
      value.Set("productUri", endpoint.product_uri);
      Napi::Array tokens = Napi::Array::New(Env(), endpoint.user_identity_tokens.size());
      for (size_t token_index = 0; token_index < endpoint.user_identity_tokens.size();
           ++token_index) {
        const auto& token = endpoint.user_identity_tokens[token_index];
        Napi::Object token_value = Napi::Object::New(Env());
        token_value.Set("policyId", token.policy_id);
        token_value.Set("tokenType", token.token_type);
        token_value.Set("securityPolicyUri", token.security_policy_uri);
        token_value.Set("issuedTokenType", token.issued_token_type);
        token_value.Set("issuerEndpointUrl", token.issuer_endpoint_url);
        tokens.Set(token_index, token_value);
      }
      value.Set("userIdentityTokens", tokens);
      output.Set(index, value);
    }
    deferred_.Resolve(output);
  }

 private:
  std::string endpoint_;
  uint32_t timeout_;
  std::vector<DiscoveredEndpoint> endpoints_;
};

class ClientCommandWorker : public PromiseWorker {
 public:
  ClientCommandWorker(Napi::Promise::Deferred deferred,
                      std::shared_ptr<ClientContext> context)
      : PromiseWorker(deferred), context_(std::move(context)) {}
  void Execute() override final {
    const std::string rejection = RunClientCommand(
        context_, [this] { ExecuteClientCommand(); });
    if (!rejection.empty()) SetError(rejection);
  }
 protected:
  virtual void ExecuteClientCommand() = 0;
  std::shared_ptr<ClientContext> context_;
};

struct ConnectionOptions {
  std::string endpoint;
  std::string security_mode;
  std::string security_policy;
  std::string user;
  std::string password;
  std::string certificate;
  std::string private_key;
  std::string private_key_password;
  std::string application_uri;
  std::vector<std::string> trusted_certificates;
  std::vector<std::string> revocation_list;
  uint32_t timeout = 10000;
  uint32_t session_timeout = 60000;
  uint32_t connectivity_check_interval = 5000;
  uint32_t node_id_cache_size = 100000;
  uint32_t command_queue_size = 256;
};

class ConnectWorker : public PromiseWorker {
 public:
  ConnectWorker(Napi::Promise::Deferred deferred, ConnectionOptions options,
                Napi::ThreadSafeFunction state_callback, bool has_state_callback)
      : PromiseWorker(deferred), options_(std::move(options)),
        state_callback_(std::move(state_callback)),
        has_state_callback_(has_state_callback) {}
  void Execute() override {
    if (options_.endpoint.empty()) { SetError("OPC UA endpoint is required"); return; }
    const UA_MessageSecurityMode security_mode = SecurityMode(options_.security_mode);
    const std::string security_policy_uri = SecurityPolicyUri(options_.security_policy);
    const bool policy_none = security_policy_uri ==
      "http://opcfoundation.org/UA/SecurityPolicy#None";
    if (security_mode == UA_MESSAGESECURITYMODE_INVALID) {
      SetError("Unsupported OPC UA security mode: " + options_.security_mode); return;
    }
    if (security_policy_uri.empty()) {
      SetError("Unsupported OPC UA security policy: " + options_.security_policy); return;
    }
    if (security_mode == UA_MESSAGESECURITYMODE_NONE && !policy_none) {
      SetError("SecurityMode None requires SecurityPolicy None"); return;
    }
    if (security_mode != UA_MESSAGESECURITYMODE_NONE) {
      if (policy_none) {
        SetError(options_.security_mode + " requires a non-None security policy"); return;
      }
      if (options_.certificate.empty() || options_.private_key.empty()) {
        SetError("Secure OPC UA connections require a client certificate and private key"); return;
      }
      if (options_.trusted_certificates.empty()) {
        SetError("Secure OPC UA connections require at least one trusted server or CA certificate"); return;
      }
    }
    context_ = std::make_shared<ClientContext>();
    context_->endpoint = options_.endpoint;
    context_->security_mode = options_.security_mode;
    context_->security_policy_uri = security_policy_uri;
    context_->identity_type = options_.user.empty() ? "Anonymous" : "Username";
    context_->private_key_password = options_.private_key_password;
    context_->state_callback = state_callback_;
    context_->has_state_callback.store(has_state_callback_);
    context_->node_id_cache_capacity = options_.node_id_cache_size;
    context_->command_queue_capacity = std::max<uint32_t>(1, options_.command_queue_size);
    context_->command_queue_timeout_ms = std::max<uint32_t>(1000, options_.timeout);
    context_->running.store(true);
    context_->iterate_thread = std::thread(Iterate, context_.get());
    const std::string rejection = RunClientCommand(
        context_, [this] { ConnectClient(); });
    if (!rejection.empty()) SetError(rejection);
    if (!connected_) {
      context_->running.store(false);
      context_->command_cv.notify_all();
      if (context_->iterate_thread.joinable()) context_->iterate_thread.join();
      return;
    }
    client_id_ = next_client_id.fetch_add(1);
    {
      std::lock_guard<std::mutex> lock(clients_mutex);
      clients[client_id_] = context_;
    }
    transferred_ = true;
  }
  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), static_cast<double>(client_id_))); }
  void OnError(const Napi::Error& error) override {
    if (has_state_callback_ && !transferred_) state_callback_.Release();
    PromiseWorker::OnError(error);
  }
 private:
  void ConnectClient() {
    context_->client = UA_Client_new();
    if (!context_->client) { SetError("Failed to create open62541 client"); return; }
    UA_ClientConfig* config = UA_Client_getConfig(context_->client);
    const UA_MessageSecurityMode security_mode = SecurityMode(options_.security_mode);
    const std::string security_policy_uri = SecurityPolicyUri(options_.security_policy);
    UA_StatusCode config_status = UA_STATUSCODE_GOOD;
    if (security_mode == UA_MESSAGESECURITYMODE_NONE) {
      config_status = UA_ClientConfig_setDefault(config);
    } else {
#ifdef UA_ENABLE_ENCRYPTION
      UA_ByteString certificate;
      UA_ByteString private_key;
      std::vector<UA_ByteString> trust_list;
      std::vector<UA_ByteString> revocation_list;
      std::string file_error;
      if (!LoadFile(options_.certificate, &certificate, &file_error)) {
        SetError(file_error); return;
      }
      if (!LoadFile(options_.private_key, &private_key, &file_error)) {
        UA_ByteString_clear(&certificate);
        SetError(file_error); return;
      }
      if (!LoadFiles(options_.trusted_certificates, &trust_list, &file_error) ||
          !LoadFiles(options_.revocation_list, &revocation_list, &file_error)) {
        UA_ByteString_clear(&certificate);
        UA_ByteString_clear(&private_key);
        ClearByteStrings(&trust_list);
        ClearByteStrings(&revocation_list);
        SetError(file_error); return;
      }
      config->clientContext = context_.get();
      config->privateKeyPasswordCallback = PrivateKeyPasswordCallback;
      config_status = UA_ClientConfig_setDefaultEncryption(
          config, certificate, private_key,
          trust_list.data(), trust_list.size(),
          revocation_list.data(), revocation_list.size());
      std::fill(context_->private_key_password.begin(),
                context_->private_key_password.end(), '\0');
      context_->private_key_password.clear();
      UA_ByteString_clear(&certificate);
      UA_ByteString_clear(&private_key);
      ClearByteStrings(&trust_list);
      ClearByteStrings(&revocation_list);
#else
      SetError("The native open62541 addon was built without encryption support"); return;
#endif
    }
    if (!UA_StatusCode_isGood(config_status)) {
      SetError("Configure OPC UA security failed: " + StatusName(config_status)); return;
    }
    config->securityMode = security_mode;
    UA_String_clear(&config->securityPolicyUri);
    config->securityPolicyUri = UA_STRING_ALLOC(security_policy_uri.c_str());
    if (!options_.application_uri.empty()) {
      UA_String_clear(&config->clientDescription.applicationUri);
      config->clientDescription.applicationUri = UA_STRING_ALLOC(options_.application_uri.c_str());
    }
    config->timeout = options_.timeout;
    config->requestedSessionTimeout = options_.session_timeout;
    config->connectivityCheckInterval = options_.connectivity_check_interval;
    config->noReconnect = false;
    config->noNewSession = false;
    config->clientContext = context_.get();
    config->stateCallback = ClientStateChanged;
    config->inactivityCallback = ClientInactivity;
    config->subscriptionInactivityCallback = SubscriptionInactivity;
    UA_StatusCode status = options_.user.empty()
        ? UA_Client_connect(context_->client, options_.endpoint.c_str())
        : UA_Client_connectUsername(context_->client, options_.endpoint.c_str(), options_.user.c_str(), options_.password.c_str());
    if (!UA_StatusCode_isGood(status)) {
      SetError("Connect failed: " + StatusName(status));
      return;
    }
    ReadOperationLimits(context_.get());
    context_->refresh_operation_limits.store(false);
    connected_ = true;
  }
  ConnectionOptions options_;
  std::shared_ptr<ClientContext> context_;
  Napi::ThreadSafeFunction state_callback_;
  bool has_state_callback_ = false;
  bool transferred_ = false;
  bool connected_ = false;
  uint64_t client_id_ = 0;
};

class DisconnectWorker : public PromiseWorker {
 public:
  DisconnectWorker(Napi::Promise::Deferred deferred, uint64_t client_id)
      : PromiseWorker(deferred), client_id_(client_id) {}
  void Execute() override { CloseClient(client_id_); }
  void OnOK() override { deferred_.Resolve(Env().Undefined()); }
 private:
  uint64_t client_id_;
};

struct ReadInput {
  std::string node_id;
  std::string index_range;
};

class ReadManyWorker : public ClientCommandWorker {
 public:
  ReadManyWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                 std::vector<ReadInput> inputs)
      : ClientCommandWorker(deferred, std::move(context)), inputs_(std::move(inputs)) {
    UA_ReadResponse_init(&response_);
  }
  ~ReadManyWorker() override { UA_ReadResponse_clear(&response_); }
  void ExecuteClientCommand() override {
    UA_ReadRequest request;
    UA_ReadRequest_init(&request);
    request.timestampsToReturn = UA_TIMESTAMPSTORETURN_BOTH;
    request.nodesToReadSize = inputs_.size();
    request.nodesToRead = static_cast<UA_ReadValueId*>(UA_Array_new(inputs_.size(), &UA_TYPES[UA_TYPES_READVALUEID]));
    if (!request.nodesToRead) { SetError("Failed to allocate batch read request"); return; }
    for (size_t index = 0; index < inputs_.size(); ++index) {
      if (!CopyCachedNodeId(context_.get(), inputs_[index].node_id, &request.nodesToRead[index].nodeId)) {
        UA_ReadRequest_clear(&request); SetError("Invalid NodeId: " + inputs_[index].node_id); return;
      }
      request.nodesToRead[index].attributeId = UA_ATTRIBUTEID_VALUE;
      if (!inputs_[index].index_range.empty()) {
        request.nodesToRead[index].indexRange = UA_STRING_ALLOC(inputs_[index].index_range.c_str());
        if (!request.nodesToRead[index].indexRange.data) {
          UA_ReadRequest_clear(&request); SetError("Failed to allocate IndexRange"); return;
        }
      }
    }
    if (!context_->client) { UA_ReadRequest_clear(&request); SetError("Client disconnected"); return; }
    response_ = UA_Client_Service_read(context_->client, request);
    UA_ReadRequest_clear(&request);
    if (!UA_StatusCode_isGood(response_.responseHeader.serviceResult)) {
      SetError("Batch read failed: " + StatusName(response_.responseHeader.serviceResult));
    }
  }
  void OnOK() override {
    Napi::Array output = Napi::Array::New(Env(), inputs_.size());
    for (size_t index = 0; index < inputs_.size(); ++index) {
      Napi::Object item = Napi::Object::New(Env());
      item.Set("nodeId", inputs_[index].node_id);
      if (!inputs_[index].index_range.empty()) item.Set("indexRange", inputs_[index].index_range);
      if (index < response_.resultsSize) {
        const UA_DataValue& value = response_.results[index];
        item.Set("statusCode", StatusName(value.status));
        if (value.hasValue) { item.Set("value", VariantValue(Env(), &value.value)); item.Set("dataType", DataTypeName(value.value.type)); }
        if (value.hasSourceTimestamp) item.Set("sourceTimestamp", DateTimeValue(Env(), value.sourceTimestamp));
        if (value.hasServerTimestamp) item.Set("serverTimestamp", DateTimeValue(Env(), value.serverTimestamp));
      } else item.Set("statusCode", "BadUnexpectedError");
      output.Set(index, item);
    }
    deferred_.Resolve(output);
  }
 private:
  std::vector<ReadInput> inputs_;
  UA_ReadResponse response_;
};

struct WriteInput {
  std::string node_id;
  std::string data_type;
  std::string index_range;
  UA_Variant value;
  WriteInput() { UA_Variant_init(&value); }
  ~WriteInput() { UA_Variant_clear(&value); }
};

class WriteManyWorker : public ClientCommandWorker {
 public:
  WriteManyWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                  std::vector<std::unique_ptr<WriteInput>> inputs)
      : ClientCommandWorker(deferred, std::move(context)), inputs_(std::move(inputs)) {
    UA_WriteResponse_init(&response_);
  }
  ~WriteManyWorker() override { UA_WriteResponse_clear(&response_); }
  void ExecuteClientCommand() override {
    UA_WriteRequest request;
    UA_WriteRequest_init(&request);
    request.nodesToWriteSize = inputs_.size();
    request.nodesToWrite = static_cast<UA_WriteValue*>(UA_Array_new(inputs_.size(), &UA_TYPES[UA_TYPES_WRITEVALUE]));
    if (!request.nodesToWrite) { SetError("Failed to allocate batch write request"); return; }
    for (size_t index = 0; index < inputs_.size(); ++index) {
      UA_WriteValue& target = request.nodesToWrite[index];
      if (!CopyCachedNodeId(context_.get(), inputs_[index]->node_id, &target.nodeId)) {
        UA_WriteRequest_clear(&request); SetError("Invalid NodeId: " + inputs_[index]->node_id); return;
      }
      target.attributeId = UA_ATTRIBUTEID_VALUE;
      if (!inputs_[index]->index_range.empty()) {
        target.indexRange = UA_STRING_ALLOC(inputs_[index]->index_range.c_str());
        if (!target.indexRange.data) {
          UA_WriteRequest_clear(&request); SetError("Failed to allocate IndexRange"); return;
        }
      }
      target.value.hasValue = true;
      UA_Variant_copy(&inputs_[index]->value, &target.value.value);
    }
    if (!context_->client) { UA_WriteRequest_clear(&request); SetError("Client disconnected"); return; }
    response_ = UA_Client_Service_write(context_->client, request);
    UA_WriteRequest_clear(&request);
    if (!UA_StatusCode_isGood(response_.responseHeader.serviceResult)) {
      SetError("Batch write failed: " + StatusName(response_.responseHeader.serviceResult));
    }
  }
  void OnOK() override {
    Napi::Array output = Napi::Array::New(Env(), inputs_.size());
    for (size_t index = 0; index < inputs_.size(); ++index) {
      Napi::Object item = Napi::Object::New(Env());
      item.Set("nodeId", inputs_[index]->node_id);
      if (!inputs_[index]->index_range.empty()) item.Set("indexRange", inputs_[index]->index_range);
      item.Set("statusCode", index < response_.resultsSize ? StatusName(response_.results[index]) : "BadUnexpectedError");
      output.Set(index, item);
    }
    deferred_.Resolve(output);
  }
 private:
  std::vector<std::unique_ptr<WriteInput>> inputs_;
  UA_WriteResponse response_;
};

struct BrowsePoint {
  std::string node_id;
  std::string parent_node_id;
  std::string browse_name;
  std::string display_name;
  std::string browse_path;
  std::string type_definition;
  uint32_t node_class = 0;
  std::string data_type;
  int32_t value_rank = -2;
  uint8_t access_level = 0;
  uint8_t user_access_level = 0;
  double minimum_sampling_interval = 0;
};

struct BrowseOptions {
  std::string root_node_id = "ns=0;i=85";
  bool recursive = true;
  bool variables_only = true;
  uint32_t max_depth = 10;
  uint32_t max_nodes = 10000;
  uint32_t browse_batch_size = 100;
  uint32_t references_per_node = 1000;
  uint32_t attribute_batch_size = 200;
  std::set<uint16_t> namespaces;
};

class BrowseWorker : public ClientCommandWorker {
 public:
  BrowseWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
               BrowseOptions options)
      : ClientCommandWorker(deferred, std::move(context)), options_(std::move(options)) {}
  void ExecuteClientCommand() override {
    UA_NodeId root;
    UA_NodeId_init(&root);
    if (!CopyCachedNodeId(context_.get(), options_.root_node_id, &root)) { SetError("Invalid root NodeId: " + options_.root_node_id); return; }
    UA_NodeId_clear(&root);
    if (!context_->client) { SetError("Client disconnected"); return; }
    if (!BrowseTree()) return;
    ReadAttributes();
  }
  void OnOK() override {
    Napi::Array output = Napi::Array::New(Env(), points_.size());
    for (size_t index = 0; index < points_.size(); ++index) {
      const BrowsePoint& point = points_[index];
      Napi::Object item = Napi::Object::New(Env());
      item.Set("nodeId", point.node_id); item.Set("parentNodeId", point.parent_node_id);
      item.Set("browseName", point.browse_name); item.Set("displayName", point.display_name);
      item.Set("browsePath", point.browse_path); item.Set("nodeClass", point.node_class == UA_NODECLASS_VARIABLE ? "Variable" : "Object");
      item.Set("typeDefinition", point.type_definition); item.Set("dataType", point.data_type);
      item.Set("valueRank", point.value_rank); item.Set("accessLevel", point.access_level);
      item.Set("userAccessLevel", point.user_access_level); item.Set("minimumSamplingInterval", point.minimum_sampling_interval);
      output.Set(index, item);
    }
    output.Set("truncated", truncated_);
    if (!truncation_reason_.empty()) output.Set("truncationReason", truncation_reason_);
    output.Set("serviceCalls", Napi::Number::New(
        Env(), static_cast<double>(service_calls_)));
    output.Set("browseBatchSize", browse_batch_size_);
    output.Set("releasedContinuationPoints", Napi::Number::New(
        Env(), static_cast<double>(released_continuation_points_)));
    Napi::Array failures = Napi::Array::New(Env(), browse_failures_.size());
    for (size_t index = 0; index < browse_failures_.size(); ++index) {
      Napi::Object failure = Napi::Object::New(Env());
      failure.Set("nodeId", browse_failures_[index].first);
      failure.Set("statusCode", browse_failures_[index].second);
      failures.Set(index, failure);
    }
    output.Set("browseFailures", failures);
    deferred_.Resolve(output);
  }
 private:
  struct QueueItem { std::string node_id; std::string path; uint32_t depth; };
  struct PendingContinuation {
    QueueItem parent;
    std::vector<UA_Byte> token;
  };

  bool NamespaceAllowed(uint16_t value) const { return options_.namespaces.empty() || options_.namespaces.count(value) > 0; }

  void MarkTruncated(const std::string& reason) {
    truncated_ = true;
    if (truncation_reason_.empty() || truncation_reason_ == "maxDepth") {
      truncation_reason_ = reason;
    }
  }

  void MarkDepthLimited() {
    depth_limited_ = true;
    if (truncation_reason_.empty()) truncation_reason_ = "maxDepth";
  }

  void ProcessBrowseResult(const QueueItem& parent, const UA_BrowseResult& result,
                           std::deque<QueueItem>* queue, std::set<std::string>* visited) {
    for (size_t index = 0; index < result.referencesSize; ++index) {
      if (points_.size() >= options_.max_nodes) {
        MarkTruncated("maxNodes");
        return;
      }
      const UA_ReferenceDescription& reference = result.references[index];
      if (reference.nodeId.serverIndex != 0 || reference.nodeId.namespaceUri.length != 0) continue;
      const UA_NodeId& node_id = reference.nodeId.nodeId;
      std::string node_id_text = NodeIdString(node_id);
      if (node_id_text.empty()) continue;
      std::string name = LocalizedTextString(reference.displayName);
      if (name.empty()) name = QualifiedNameString(reference.browseName);
      std::string path = parent.path.empty() ? name : parent.path + "/" + name;
      bool output = !options_.variables_only || reference.nodeClass == UA_NODECLASS_VARIABLE;
      if (output && NamespaceAllowed(node_id.namespaceIndex)) {
        BrowsePoint point;
        point.node_id = node_id_text; point.parent_node_id = parent.node_id;
        point.browse_name = QualifiedNameString(reference.browseName);
        point.display_name = LocalizedTextString(reference.displayName); point.browse_path = path;
        point.node_class = reference.nodeClass; point.type_definition = NodeIdString(reference.typeDefinition.nodeId);
        points_.push_back(std::move(point));
      }
      if (options_.recursive) {
        if (parent.depth < options_.max_depth) {
          if (visited->insert(node_id_text).second) {
            queue->push_back({node_id_text, path, parent.depth + 1});
          }
        } else if (reference.nodeClass == UA_NODECLASS_OBJECT) {
          MarkDepthLimited();
        }
      }
    }
  }

  static PendingContinuation Continuation(
      const QueueItem& parent, const UA_ByteString& point) {
    PendingContinuation output{parent, {}};
    if (point.length && point.data) {
      output.token.assign(point.data, point.data + point.length);
    }
    return output;
  }

  bool FillContinuationPoints(
      const std::vector<PendingContinuation>& pending, size_t start, size_t count,
      UA_BrowseNextRequest* request) {
    request->continuationPointsSize = count;
    request->continuationPoints = static_cast<UA_ByteString*>(
        UA_Array_new(count, &UA_TYPES[UA_TYPES_BYTESTRING]));
    if (!request->continuationPoints) return false;
    for (size_t index = 0; index < count; ++index) {
      const auto& token = pending[start + index].token;
      UA_ByteString source;
      source.length = token.size();
      source.data = const_cast<UA_Byte*>(token.data());
      if (UA_ByteString_copy(&source, &request->continuationPoints[index]) !=
          UA_STATUSCODE_GOOD) {
        return false;
      }
    }
    return true;
  }

  void ReleaseContinuations(const std::vector<PendingContinuation>& pending) {
    for (size_t start = 0; start < pending.size(); start += browse_batch_size_) {
      const size_t count = std::min<size_t>(
          browse_batch_size_, pending.size() - start);
      UA_BrowseNextRequest request;
      UA_BrowseNextRequest_init(&request);
      request.releaseContinuationPoints = true;
      if (!FillContinuationPoints(pending, start, count, &request)) {
        UA_BrowseNextRequest_clear(&request);
        continue;
      }
      UA_BrowseNextResponse response =
          UA_Client_Service_browseNext(context_->client, request);
      ++service_calls_;
      UA_BrowseNextRequest_clear(&request);
      UA_BrowseNextResponse_clear(&response);
      released_continuation_points_ += count;
    }
  }

  bool BrowseContinuations(
      std::vector<PendingContinuation>* pending, std::deque<QueueItem>* queue,
      std::set<std::string>* visited) {
    while (!pending->empty()) {
      std::vector<PendingContinuation> next_pending;
      for (size_t start = 0; start < pending->size(); start += browse_batch_size_) {
        const size_t count = std::min<size_t>(
            browse_batch_size_, pending->size() - start);
        UA_BrowseNextRequest request;
        UA_BrowseNextRequest_init(&request);
        if (!FillContinuationPoints(*pending, start, count, &request)) {
          UA_BrowseNextRequest_clear(&request);
          ReleaseContinuations(*pending);
          SetError("Failed to allocate BrowseNext continuation points");
          return false;
        }
        UA_BrowseNextResponse response =
            UA_Client_Service_browseNext(context_->client, request);
        ++service_calls_;
        UA_BrowseNextRequest_clear(&request);
        if (!UA_StatusCode_isGood(response.responseHeader.serviceResult)) {
          const std::string status = StatusName(
              response.responseHeader.serviceResult);
          UA_BrowseNextResponse_clear(&response);
          ReleaseContinuations(*pending);
          SetError("BrowseNext failed: " + status);
          return false;
        }
        for (size_t index = 0; index < count; ++index) {
          const auto& parent = (*pending)[start + index].parent;
          if (index < response.resultsSize) {
            const UA_BrowseResult& result = response.results[index];
            if (UA_StatusCode_isGood(result.statusCode) && !truncated_) {
              ProcessBrowseResult(parent, result, queue, visited);
            } else if (!UA_StatusCode_isGood(result.statusCode)) {
              browse_failures_.push_back(
                  {parent.node_id, StatusName(result.statusCode)});
            }
            if (result.continuationPoint.length) {
              next_pending.push_back(
                  Continuation(parent, result.continuationPoint));
            }
          } else {
            browse_failures_.push_back(
                {parent.node_id, "BadUnexpectedError"});
          }
        }
        UA_BrowseNextResponse_clear(&response);
      }
      if (truncated_) {
        ReleaseContinuations(next_pending);
        return true;
      }
      *pending = std::move(next_pending);
    }
    return true;
  }

  bool BrowseTree() {
    std::deque<QueueItem> queue{{options_.root_node_id, "", 0}};
    std::set<std::string> visited{options_.root_node_id};
    browse_batch_size_ = std::max<uint32_t>(1, options_.browse_batch_size);
    const uint32_t server_limit =
        context_->operation_limits.max_nodes_per_browse.load();
    if (server_limit > 0) {
      browse_batch_size_ = std::min(browse_batch_size_, server_limit);
    }
    while (!queue.empty() && !truncated_) {
      std::vector<QueueItem> batch;
      batch.reserve(browse_batch_size_);
      while (!queue.empty() && batch.size() < browse_batch_size_) {
        batch.push_back(std::move(queue.front()));
        queue.pop_front();
      }
      UA_BrowseRequest request; UA_BrowseRequest_init(&request);
      request.requestedMaxReferencesPerNode = options_.references_per_node;
      request.nodesToBrowseSize = batch.size();
      request.nodesToBrowse = static_cast<UA_BrowseDescription*>(
          UA_Array_new(batch.size(), &UA_TYPES[UA_TYPES_BROWSEDESCRIPTION]));
      if (!request.nodesToBrowse) {
        SetError("Failed to allocate Browse request");
        return false;
      }
      for (size_t index = 0; index < batch.size(); ++index) {
        if (!CopyCachedNodeId(context_.get(), batch[index].node_id,
                              &request.nodesToBrowse[index].nodeId)) {
          const std::string invalid = batch[index].node_id;
          UA_BrowseRequest_clear(&request);
          SetError("Invalid browse NodeId: " + invalid);
          return false;
        }
        auto& description = request.nodesToBrowse[index];
        description.browseDirection = UA_BROWSEDIRECTION_FORWARD;
        description.referenceTypeId =
            UA_NODEID_NUMERIC(0, UA_NS0ID_HIERARCHICALREFERENCES);
        description.includeSubtypes = true;
        description.nodeClassMask = UA_NODECLASS_OBJECT | UA_NODECLASS_VARIABLE;
        description.resultMask = UA_BROWSERESULTMASK_ALL;
      }
      UA_BrowseResponse response = UA_Client_Service_browse(context_->client, request);
      ++service_calls_;
      UA_BrowseRequest_clear(&request);
      if (!UA_StatusCode_isGood(response.responseHeader.serviceResult)) {
        UA_BrowseResponse_clear(&response); SetError("Browse failed: " + StatusName(response.responseHeader.serviceResult)); return false;
      }
      std::vector<PendingContinuation> pending;
      for (size_t index = 0; index < batch.size(); ++index) {
        if (index < response.resultsSize) {
          const UA_BrowseResult& result = response.results[index];
          if (UA_StatusCode_isGood(result.statusCode) && !truncated_) {
            ProcessBrowseResult(batch[index], result, &queue, &visited);
          } else if (!UA_StatusCode_isGood(result.statusCode)) {
            browse_failures_.push_back(
                {batch[index].node_id, StatusName(result.statusCode)});
          }
          if (result.continuationPoint.length) {
            pending.push_back(
                Continuation(batch[index], result.continuationPoint));
          }
        } else {
          browse_failures_.push_back(
              {batch[index].node_id, "BadUnexpectedError"});
        }
      }
      UA_BrowseResponse_clear(&response);
      if (points_.size() >= options_.max_nodes &&
          (!pending.empty() || !queue.empty())) {
        MarkTruncated("maxNodes");
      }
      if (truncated_) {
        ReleaseContinuations(pending);
        break;
      }
      if (!BrowseContinuations(&pending, &queue, &visited)) return false;
      if (points_.size() >= options_.max_nodes && !queue.empty()) {
        MarkTruncated("maxNodes");
      }
    }
    if (depth_limited_) truncated_ = true;
    return true;
  }

  void ReadAttributes() {
    const size_t attrs = 5;
    size_t batch = std::max<size_t>(1, options_.attribute_batch_size) * attrs;
    uint32_t read_limit = context_->operation_limits.max_nodes_per_read.load();
    if (read_limit > 0) batch = std::min<size_t>(batch, read_limit);
    const size_t total_attributes = points_.size() * attrs;
    const UA_UInt32 ids[attrs] = {
        UA_ATTRIBUTEID_DATATYPE, UA_ATTRIBUTEID_VALUERANK,
        UA_ATTRIBUTEID_ACCESSLEVEL, UA_ATTRIBUTEID_USERACCESSLEVEL,
        UA_ATTRIBUTEID_MINIMUMSAMPLINGINTERVAL};
    for (size_t start = 0; start < total_attributes; start += batch) {
      size_t count = std::min(batch, total_attributes - start);
      UA_ReadRequest request; UA_ReadRequest_init(&request);
      request.timestampsToReturn = UA_TIMESTAMPSTORETURN_NEITHER;
      request.nodesToReadSize = count;
      request.nodesToRead = static_cast<UA_ReadValueId*>(UA_Array_new(request.nodesToReadSize, &UA_TYPES[UA_TYPES_READVALUEID]));
      if (!request.nodesToRead) return;
      for (size_t index = 0; index < count; ++index) {
        size_t flat_index = start + index;
        size_t point_index = flat_index / attrs;
        size_t attr_index = flat_index % attrs;
        auto& target = request.nodesToRead[index];
        CopyCachedNodeId(context_.get(), points_[point_index].node_id, &target.nodeId);
        target.attributeId = ids[attr_index];
      }
      UA_ReadResponse response = UA_Client_Service_read(context_->client, request);
      UA_ReadRequest_clear(&request);
      if (UA_StatusCode_isGood(response.responseHeader.serviceResult)) {
        for (size_t index = 0; index < count && index < response.resultsSize; ++index) {
          size_t flat_index = start + index;
          BrowsePoint& point = points_[flat_index / attrs];
          size_t attr_index = flat_index % attrs;
          const auto& value = response.results[index];
          if (!value.hasValue) continue;
          if (attr_index == 0 && value.value.type == &UA_TYPES[UA_TYPES_NODEID]) {
            point.data_type = BuiltinTypeName(*static_cast<UA_NodeId*>(value.value.data));
          } else if (attr_index == 1 && value.value.type == &UA_TYPES[UA_TYPES_INT32]) {
            point.value_rank = *static_cast<UA_Int32*>(value.value.data);
          } else if (attr_index == 2 && value.value.type == &UA_TYPES[UA_TYPES_BYTE]) {
            point.access_level = *static_cast<UA_Byte*>(value.value.data);
          } else if (attr_index == 3 && value.value.type == &UA_TYPES[UA_TYPES_BYTE]) {
            point.user_access_level = *static_cast<UA_Byte*>(value.value.data);
          } else if (attr_index == 4 && value.value.type == &UA_TYPES[UA_TYPES_DOUBLE]) {
            point.minimum_sampling_interval = *static_cast<UA_Double*>(value.value.data);
          }
        }
      }
      UA_ReadResponse_clear(&response);
    }
  }

  BrowseOptions options_;
  std::vector<BrowsePoint> points_;
  uint32_t browse_batch_size_ = 1;
  uint64_t service_calls_ = 0;
  uint64_t released_continuation_points_ = 0;
  bool truncated_ = false;
  bool depth_limited_ = false;
  std::string truncation_reason_;
  std::vector<std::pair<std::string, std::string>> browse_failures_;
};

class CreateSubscriptionWorker : public ClientCommandWorker {
 public:
  CreateSubscriptionWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                           Napi::Function callback, uint32_t queue_size, double publishing_interval,
                           uint32_t lifetime, uint32_t keepalive, uint32_t max_notifications,
                           uint32_t callback_batch_size, std::string queue_mode,
                           std::string overflow_policy)
      : ClientCommandWorker(deferred, std::move(context)), publishing_interval_(publishing_interval),
        lifetime_(lifetime), keepalive_(keepalive), max_notifications_(max_notifications),
        queue_size_(std::max<uint32_t>(1, queue_size)),
        callback_batch_size_(std::max<uint32_t>(1, callback_batch_size)),
        queue_mode_(queue_mode == "latest" ? "latest" : "all"),
        overflow_policy_(overflow_policy == "drop-newest" ? "drop-newest" : "drop-oldest") {
    callback_ = Napi::ThreadSafeFunction::New(Env(), callback, "OpcUaDataChangeBatches", 1, 1);
  }
  void ExecuteClientCommand() override {
    UA_CreateSubscriptionRequest request = UA_CreateSubscriptionRequest_default();
    request.requestedPublishingInterval = publishing_interval_;
    request.requestedLifetimeCount = lifetime_;
    request.requestedMaxKeepAliveCount = keepalive_;
    request.maxNotificationsPerPublish = max_notifications_;
    if (!context_->client) { SetError("Client disconnected"); return; }
    UA_CreateSubscriptionResponse response = UA_Client_Subscriptions_create(context_->client, request, nullptr, nullptr, nullptr);
    status_ = response.responseHeader.serviceResult; subscription_id_ = response.subscriptionId;
    revised_publishing_interval_ = response.revisedPublishingInterval;
    revised_lifetime_ = response.revisedLifetimeCount;
    revised_keepalive_ = response.revisedMaxKeepAliveCount;
    UA_CreateSubscriptionResponse_clear(&response);
    if (!UA_StatusCode_isGood(status_)) { SetError("Create subscription failed: " + StatusName(status_)); return; }
    auto subscription = std::make_unique<SubscriptionContext>();
    subscription->subscription_id = subscription_id_;
    subscription->notifications = std::make_shared<NotificationQueue>();
    subscription->notifications->callback = callback_;
    subscription->notifications->capacity = queue_size_;
    subscription->notifications->batch_size = callback_batch_size_;
    subscription->notifications->mode = queue_mode_;
    subscription->notifications->overflow_policy = overflow_policy_;
    context_->subscriptions[subscription_id_] = std::move(subscription); transferred_ = true;
  }
  void OnOK() override { Napi::Object result = Napi::Object::New(Env()); result.Set("subscriptionId", subscription_id_); result.Set("statusCode", StatusName(status_)); result.Set("revisedPublishingInterval", revised_publishing_interval_); result.Set("revisedLifetimeCount", revised_lifetime_); result.Set("revisedMaxKeepAliveCount", revised_keepalive_); deferred_.Resolve(result); }
  void OnError(const Napi::Error& error) override { if (!transferred_) callback_.Release(); PromiseWorker::OnError(error); }
 private:
  Napi::ThreadSafeFunction callback_; bool transferred_ = false;
  double publishing_interval_; uint32_t lifetime_; uint32_t keepalive_; uint32_t max_notifications_;
  uint32_t queue_size_; uint32_t callback_batch_size_; std::string queue_mode_; std::string overflow_policy_;
  uint32_t subscription_id_ = 0; UA_StatusCode status_ = UA_STATUSCODE_GOOD;
  double revised_publishing_interval_ = 0; uint32_t revised_lifetime_ = 0; uint32_t revised_keepalive_ = 0;
};

struct MonitorInput { std::string node_id; double sampling_interval; uint32_t queue_size; bool discard_oldest; std::string deadband_type; double deadband_value; };
struct MonitorResult { std::string node_id; uint32_t monitored_item_id = 0; uint32_t client_handle = 0; double revised_sampling_interval = 0; uint32_t revised_queue_size = 0; UA_StatusCode status = UA_STATUSCODE_BADUNEXPECTEDERROR; };

class AddMonitoredWorker : public ClientCommandWorker {
 public:
  AddMonitoredWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                     uint32_t subscription_id, std::vector<MonitorInput> inputs,
                     UA_TimestampsToReturn timestamps_to_return)
      : ClientCommandWorker(deferred, std::move(context)), subscription_id_(subscription_id),
        inputs_(std::move(inputs)), timestamps_to_return_(timestamps_to_return) {}
  void ExecuteClientCommand() override {
    auto subscription_it = context_->subscriptions.find(subscription_id_);
    if (!context_->client || subscription_it == context_->subscriptions.end()) { SetError("Subscription not found"); return; }
    auto* subscription = subscription_it->second.get();
    UA_CreateMonitoredItemsRequest request; UA_CreateMonitoredItemsRequest_init(&request);
    request.subscriptionId = subscription_id_; request.timestampsToReturn = timestamps_to_return_;
    request.itemsToCreateSize = inputs_.size();
    request.itemsToCreate = static_cast<UA_MonitoredItemCreateRequest*>(UA_Array_new(inputs_.size(), &UA_TYPES[UA_TYPES_MONITOREDITEMCREATEREQUEST]));
    std::vector<std::unique_ptr<MonitoredContext>> contexts(inputs_.size());
    std::vector<void*> context_ptrs(inputs_.size());
    std::vector<UA_Client_DataChangeNotificationCallback> callbacks(inputs_.size(), DataChange);
    std::vector<std::unique_ptr<UA_DataChangeFilter>> filters(inputs_.size());
    for (size_t index = 0; index < inputs_.size(); ++index) {
      auto& item = request.itemsToCreate[index];
      if (!CopyCachedNodeId(context_.get(), inputs_[index].node_id, &item.itemToMonitor.nodeId)) { UA_CreateMonitoredItemsRequest_clear(&request); SetError("Invalid NodeId: " + inputs_[index].node_id); return; }
      item.itemToMonitor.attributeId = UA_ATTRIBUTEID_VALUE; item.monitoringMode = UA_MONITORINGMODE_REPORTING;
      uint32_t client_handle = 0;
      do {
        client_handle = subscription->next_client_handle++;
      } while (client_handle == 0 ||
               subscription->monitored_by_client_handle.find(client_handle) !=
                   subscription->monitored_by_client_handle.end());
      item.requestedParameters.clientHandle = client_handle;
      item.requestedParameters.samplingInterval = inputs_[index].sampling_interval;
      item.requestedParameters.queueSize = inputs_[index].queue_size;
      item.requestedParameters.discardOldest = inputs_[index].discard_oldest;
      if (inputs_[index].deadband_type != "none") {
        filters[index] = std::make_unique<UA_DataChangeFilter>(); UA_DataChangeFilter_init(filters[index].get());
        filters[index]->trigger = UA_DATACHANGETRIGGER_STATUSVALUE;
        filters[index]->deadbandType = inputs_[index].deadband_type == "percent" ? UA_DEADBANDTYPE_PERCENT : UA_DEADBANDTYPE_ABSOLUTE;
        filters[index]->deadbandValue = inputs_[index].deadband_value;
        item.requestedParameters.filter.encoding = UA_EXTENSIONOBJECT_DECODED;
        item.requestedParameters.filter.content.decoded.type = &UA_TYPES[UA_TYPES_DATACHANGEFILTER];
        item.requestedParameters.filter.content.decoded.data = filters[index].get();
      }
      contexts[index] = std::make_unique<MonitoredContext>(); contexts[index]->notifications = subscription->notifications; contexts[index]->node_id = inputs_[index].node_id; contexts[index]->client_handle = client_handle; context_ptrs[index] = contexts[index].get();
    }
    UA_CreateMonitoredItemsResponse response = UA_Client_MonitoredItems_createDataChanges(context_->client, request, context_ptrs.data(), callbacks.data(), nullptr);
    for (size_t index = 0; index < filters.size(); ++index) {
      if (filters[index]) UA_ExtensionObject_init(&request.itemsToCreate[index].requestedParameters.filter);
    }
    UA_CreateMonitoredItemsRequest_clear(&request);
    if (!UA_StatusCode_isGood(response.responseHeader.serviceResult)) { UA_CreateMonitoredItemsResponse_clear(&response); SetError("Create monitored items failed: " + StatusName(response.responseHeader.serviceResult)); return; }
    for (size_t index = 0; index < inputs_.size(); ++index) {
      MonitorResult result; result.node_id = inputs_[index].node_id; result.client_handle = contexts[index]->client_handle;
      if (index < response.resultsSize) {
        result.status = response.results[index].statusCode; result.monitored_item_id = response.results[index].monitoredItemId; result.revised_sampling_interval = response.results[index].revisedSamplingInterval; result.revised_queue_size = response.results[index].revisedQueueSize;
        if (UA_StatusCode_isGood(result.status)) { contexts[index]->monitored_item_id = result.monitored_item_id; auto* monitored_context = contexts[index].get(); subscription->monitored_by_client_handle[monitored_context->client_handle] = monitored_context; subscription->monitored[result.monitored_item_id] = std::move(contexts[index]); }
      }
      results_.push_back(result);
    }
    UA_CreateMonitoredItemsResponse_clear(&response);
  }
  void OnOK() override { Napi::Array output = Napi::Array::New(Env(), results_.size()); for (size_t index = 0; index < results_.size(); ++index) { Napi::Object item = Napi::Object::New(Env()); item.Set("nodeId", results_[index].node_id); item.Set("monitoredItemId", results_[index].monitored_item_id); item.Set("clientHandle", results_[index].client_handle); item.Set("revisedSamplingInterval", results_[index].revised_sampling_interval); item.Set("revisedQueueSize", results_[index].revised_queue_size); item.Set("statusCode", StatusName(results_[index].status)); output.Set(index, item); } deferred_.Resolve(output); }
 private:
  uint32_t subscription_id_; std::vector<MonitorInput> inputs_; std::vector<MonitorResult> results_;
  UA_TimestampsToReturn timestamps_to_return_;
};

class RemoveMonitoredWorker : public ClientCommandWorker {
 public:
  RemoveMonitoredWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                        uint32_t subscription_id, std::vector<uint32_t> ids)
      : ClientCommandWorker(deferred, std::move(context)), subscription_id_(subscription_id), ids_(std::move(ids)) { UA_DeleteMonitoredItemsResponse_init(&response_); }
  ~RemoveMonitoredWorker() override { UA_DeleteMonitoredItemsResponse_clear(&response_); }
  void ExecuteClientCommand() override {
    auto sub = context_->subscriptions.find(subscription_id_);
    if (!context_->client || sub == context_->subscriptions.end()) { SetError("Subscription not found"); return; }
    UA_DeleteMonitoredItemsRequest request; UA_DeleteMonitoredItemsRequest_init(&request); request.subscriptionId = subscription_id_; request.monitoredItemIdsSize = ids_.size(); request.monitoredItemIds = static_cast<UA_UInt32*>(UA_Array_new(ids_.size(), &UA_TYPES[UA_TYPES_UINT32]));
    std::copy(ids_.begin(), ids_.end(), request.monitoredItemIds); response_ = UA_Client_MonitoredItems_delete(context_->client, request); UA_DeleteMonitoredItemsRequest_clear(&request);
    if (!UA_StatusCode_isGood(response_.responseHeader.serviceResult)) { SetError("Delete monitored items failed: " + StatusName(response_.responseHeader.serviceResult)); return; }
    for (size_t index = 0; index < ids_.size() && index < response_.resultsSize; ++index) if (UA_StatusCode_isGood(response_.results[index])) { auto monitored = sub->second->monitored.find(ids_[index]); if (monitored != sub->second->monitored.end()) { sub->second->monitored_by_client_handle.erase(monitored->second->client_handle); sub->second->monitored.erase(monitored); } }
  }
  void OnOK() override { Napi::Array output = Napi::Array::New(Env(), ids_.size()); for (size_t index = 0; index < ids_.size(); ++index) { Napi::Object item = Napi::Object::New(Env()); item.Set("monitoredItemId", ids_[index]); item.Set("statusCode", index < response_.resultsSize ? StatusName(response_.results[index]) : "BadUnexpectedError"); output.Set(index, item); } deferred_.Resolve(output); }
 private:
  uint32_t subscription_id_; std::vector<uint32_t> ids_; UA_DeleteMonitoredItemsResponse response_;
};

class ValidateSubscriptionWorker : public ClientCommandWorker {
 public:
  ValidateSubscriptionWorker(Napi::Promise::Deferred deferred,
                             std::shared_ptr<ClientContext> context, uint32_t id)
      : ClientCommandWorker(deferred, std::move(context)), id_(id) {}
  void ExecuteClientCommand() override {
    if (!context_->client || !context_->connected.load()) {
      SetError("Client reconnecting");
      return;
    }
    if (context_->subscriptions.find(id_) == context_->subscriptions.end()) {
      status_ = UA_STATUSCODE_BADSUBSCRIPTIONIDINVALID;
      return;
    }
    UA_SetPublishingModeRequest request;
    UA_SetPublishingModeRequest_init(&request);
    request.publishingEnabled = true;
    request.subscriptionIdsSize = 1;
    request.subscriptionIds = static_cast<UA_UInt32*>(
        UA_Array_new(1, &UA_TYPES[UA_TYPES_UINT32]));
    if (!request.subscriptionIds) {
      SetError("Failed to allocate subscription validation request");
      return;
    }
    request.subscriptionIds[0] = id_;
    UA_SetPublishingModeResponse response =
        UA_Client_Subscriptions_setPublishingMode(context_->client, request);
    UA_SetPublishingModeRequest_clear(&request);
    if (!UA_StatusCode_isGood(response.responseHeader.serviceResult)) {
      UA_StatusCode service_status = response.responseHeader.serviceResult;
      UA_SetPublishingModeResponse_clear(&response);
      SetError("Validate subscription failed: " + StatusName(service_status));
      return;
    }
    status_ = response.resultsSize ? response.results[0] : UA_STATUSCODE_BADUNEXPECTEDERROR;
    UA_SetPublishingModeResponse_clear(&response);
  }
  void OnOK() override {
    Napi::Object output = Napi::Object::New(Env());
    output.Set("subscriptionId", id_);
    output.Set("valid", UA_StatusCode_isGood(status_));
    output.Set("statusCode", StatusName(status_));
    deferred_.Resolve(output);
  }
 private:
  uint32_t id_;
  UA_StatusCode status_ = UA_STATUSCODE_GOOD;
};

class DeleteSubscriptionWorker : public ClientCommandWorker {
 public:
  DeleteSubscriptionWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context, uint32_t id)
      : ClientCommandWorker(deferred, std::move(context)), id_(id) {}
  void ExecuteClientCommand() override { auto found = context_->subscriptions.find(id_); if (found == context_->subscriptions.end()) return; status_ = context_->client ? UA_Client_Subscriptions_deleteSingle(context_->client, id_) : UA_STATUSCODE_BADCONNECTIONCLOSED; CloseNotificationQueue(found->second->notifications); context_->subscriptions.erase(found); if (!UA_StatusCode_isGood(status_)) SetError("Delete subscription failed: " + StatusName(status_)); }
  void OnOK() override { Napi::Object result = Napi::Object::New(Env()); result.Set("subscriptionId", id_); result.Set("statusCode", StatusName(status_)); deferred_.Resolve(result); }
 private:
  uint32_t id_; UA_StatusCode status_ = UA_STATUSCODE_GOOD;
};

std::shared_ptr<ClientContext> RequireClient(Napi::Env env, const Napi::Value& value) {
  if (!value.IsNumber()) { Napi::TypeError::New(env, "clientId must be a number").ThrowAsJavaScriptException(); return nullptr; }
  auto context = FindClient(static_cast<uint64_t>(value.As<Napi::Number>().Int64Value()));
  if (!context) Napi::Error::New(env, "OPC UA client not found").ThrowAsJavaScriptException();
  return context;
}

Napi::Value GetClientDiagnostics(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto context = RequireClient(env, info[0]);
  if (!context) return env.Undefined();
  Napi::Object result = Napi::Object::New(env);
  Napi::Object limits = Napi::Object::New(env);
  limits.Set("maxNodesPerRead", context->operation_limits.max_nodes_per_read.load());
  limits.Set("maxNodesPerWrite", context->operation_limits.max_nodes_per_write.load());
  limits.Set("maxNodesPerBrowse", context->operation_limits.max_nodes_per_browse.load());
  limits.Set("maxMonitoredItemsPerCall", context->operation_limits.max_monitored_items_per_call.load());
  limits.Set("maxMonitoredItemsPerSubscription", context->operation_limits.max_monitored_items_per_subscription.load());
  result.Set("operationLimits", limits);

  Napi::Object connection = Napi::Object::New(env);
  connection.Set("state", context->connected.load() ? "connected" :
      (UA_StatusCode_isGood(context->connect_status.load()) ? "reconnecting" : "failed"));
  connection.Set("connected", context->connected.load());
  connection.Set("channelState", ChannelStateName(context->channel_state.load()));
  connection.Set("sessionState", SessionStateName(context->session_state.load()));
  connection.Set("statusCode", StatusName(context->connect_status.load()));
  connection.Set("stateSequence", Napi::Number::New(env, static_cast<double>(context->state_sequence.load())));
  connection.Set("reconnectCount", Napi::Number::New(env, static_cast<double>(context->reconnect_count.load())));
  connection.Set("disconnectCount", Napi::Number::New(env, static_cast<double>(context->disconnect_count.load())));
  connection.Set("sessionGeneration", Napi::Number::New(env, static_cast<double>(context->session_generation.load())));
  connection.Set("endpoint", context->endpoint);
  connection.Set("securityMode", context->security_mode);
  connection.Set("securityPolicyUri", context->security_policy_uri);
  connection.Set("identityType", context->identity_type);
  result.Set("connection", connection);

  size_t command_queue_depth = 0;
  size_t command_queue_max_depth = 0;
  {
    std::lock_guard<std::mutex> lock(context->command_mutex);
    command_queue_depth = context->commands.size();
    command_queue_max_depth = context->command_queue_max_depth;
  }
  Napi::Object command_queue = Napi::Object::New(env);
  command_queue.Set("depth", Napi::Number::New(env, static_cast<double>(command_queue_depth)));
  command_queue.Set("capacity", Napi::Number::New(env, static_cast<double>(context->command_queue_capacity)));
  command_queue.Set("maxDepth", Napi::Number::New(env, static_cast<double>(command_queue_max_depth)));
  command_queue.Set("active", context->commands_active.load());
  command_queue.Set("enqueued", Napi::Number::New(env, static_cast<double>(context->commands_enqueued.load())));
  command_queue.Set("completed", Napi::Number::New(env, static_cast<double>(context->commands_completed.load())));
  command_queue.Set("rejected", Napi::Number::New(env, static_cast<double>(context->commands_rejected.load())));
  command_queue.Set("timedOut", Napi::Number::New(env, static_cast<double>(context->commands_timed_out.load())));
  result.Set("commandQueue", command_queue);

  size_t cache_size = 0;
  {
    std::lock_guard<std::mutex> lock(context->node_id_cache_mutex);
    cache_size = context->node_id_cache.size();
  }
  Napi::Object cache = Napi::Object::New(env);
  cache.Set("size", Napi::Number::New(env, static_cast<double>(cache_size)));
  cache.Set("capacity", Napi::Number::New(env, static_cast<double>(context->node_id_cache_capacity)));
  cache.Set("hits", Napi::Number::New(env, static_cast<double>(context->node_id_cache_hits.load())));
  cache.Set("misses", Napi::Number::New(env, static_cast<double>(context->node_id_cache_misses.load())));
  cache.Set("bypasses", Napi::Number::New(env, static_cast<double>(context->node_id_cache_bypasses.load())));
  cache.Set("evictions", Napi::Number::New(env, static_cast<double>(context->node_id_cache_evictions.load())));
  result.Set("nodeIdCache", cache);
  return result;
}

Napi::Value ConnectAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); if (info.Length() < 1 || !info[0].IsObject()) { Napi::TypeError::New(env, "Connection options are required").ThrowAsJavaScriptException(); return env.Undefined(); }
  Napi::Object object = info[0].As<Napi::Object>(); ConnectionOptions options;
  options.endpoint = GetString(object, "endpoint"); options.security_mode = GetString(object, "securityMode", "None"); options.security_policy = GetString(object, "securityPolicy", "None"); options.user = GetString(object, "user"); options.password = GetString(object, "password"); options.certificate = GetString(object, "certificate"); options.private_key = GetString(object, "privateKey"); options.private_key_password = GetString(object, "privateKeyPassword"); options.application_uri = GetString(object, "applicationUri"); options.timeout = GetUInt(object, "requestTimeout", 10000); options.session_timeout = GetUInt(object, "requestedSessionTimeout", 60000); options.connectivity_check_interval = GetUInt(object, "connectivityCheckInterval", 5000); options.node_id_cache_size = GetUInt(object, "nodeIdCacheSize", 100000); options.command_queue_size = GetUInt(object, "commandQueueSize", 256);
  if (object.Has("trustedCertificates") && object.Get("trustedCertificates").IsArray()) { Napi::Array values = object.Get("trustedCertificates").As<Napi::Array>(); for (uint32_t index = 0; index < values.Length(); ++index) if (values.Get(index).IsString()) options.trusted_certificates.push_back(values.Get(index).As<Napi::String>().Utf8Value()); }
  if (object.Has("revocationList") && object.Get("revocationList").IsArray()) { Napi::Array values = object.Get("revocationList").As<Napi::Array>(); for (uint32_t index = 0; index < values.Length(); ++index) if (values.Get(index).IsString()) options.revocation_list.push_back(values.Get(index).As<Napi::String>().Utf8Value()); }
  bool has_state_callback = info.Length() > 1 && info[1].IsFunction();
  Napi::ThreadSafeFunction state_callback;
  if (has_state_callback) {
    state_callback = Napi::ThreadSafeFunction::New(
        env, info[1].As<Napi::Function>(), "OPC UA connection state", 64, 1);
  }
  auto deferred = Napi::Promise::Deferred::New(env); (new ConnectWorker(deferred, std::move(options), std::move(state_callback), has_state_callback))->Queue(); return deferred.Promise();
}

Napi::Value DiscoverEndpointsAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsObject()) {
    Napi::TypeError::New(env, "Discovery options are required").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object options = info[0].As<Napi::Object>();
  auto deferred = Napi::Promise::Deferred::New(env);
  (new DiscoverEndpointsWorker(
      deferred, GetString(options, "endpoint"), GetUInt(options, "requestTimeout", 10000)))->Queue();
  return deferred.Promise();
}

Napi::Value DisconnectAsync(const Napi::CallbackInfo& info) { Napi::Env env = info.Env(); uint64_t id = info[0].As<Napi::Number>().Int64Value(); auto deferred = Napi::Promise::Deferred::New(env); (new DisconnectWorker(deferred, id))->Queue(); return deferred.Promise(); }

Napi::Value ReadManyAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[1].IsArray()) return env.Undefined(); Napi::Array array = info[1].As<Napi::Array>(); std::vector<ReadInput> inputs; inputs.reserve(array.Length());
  for (uint32_t index = 0; index < array.Length(); ++index) { Napi::Value value = array.Get(index); ReadInput input; if (value.IsString()) input.node_id = value.As<Napi::String>().Utf8Value(); else { Napi::Object object = value.As<Napi::Object>(); input.node_id = GetString(object, "nodeId"); input.index_range = GetString(object, "indexRange"); } inputs.push_back(std::move(input)); }
  auto deferred = Napi::Promise::Deferred::New(env); (new ReadManyWorker(deferred, context, std::move(inputs)))->Queue(); return deferred.Promise();
}

Napi::Value WriteManyAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[1].IsArray()) return env.Undefined(); Napi::Array array = info[1].As<Napi::Array>(); std::vector<std::unique_ptr<WriteInput>> inputs;
  for (uint32_t index = 0; index < array.Length(); ++index) { Napi::Object object = array.Get(index).As<Napi::Object>(); auto input = std::make_unique<WriteInput>(); input->node_id = GetString(object, "nodeId"); input->data_type = GetString(object, "dataType", "String"); input->index_range = GetString(object, "indexRange"); if (!object.Has("value")) { Napi::TypeError::New(env, "Write point is missing value").ThrowAsJavaScriptException(); return env.Undefined(); } if (!JsValueToVariant(env, object.Get("value"), input->data_type, &input->value)) return env.Undefined(); inputs.push_back(std::move(input)); }
  auto deferred = Napi::Promise::Deferred::New(env); (new WriteManyWorker(deferred, context, std::move(inputs)))->Queue(); return deferred.Promise();
}

Napi::Value BrowseAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[1].IsObject()) return env.Undefined(); Napi::Object object = info[1].As<Napi::Object>(); BrowseOptions options;
  options.root_node_id = GetString(object, "rootNodeId", "ns=0;i=85"); options.recursive = GetBool(object, "recursive", true); options.variables_only = GetBool(object, "variablesOnly", true); options.max_depth = GetUInt(object, "maxDepth", 10); options.max_nodes = GetUInt(object, "maxNodes", 10000); options.browse_batch_size = GetUInt(object, "browseBatchSize", 100); options.references_per_node = GetUInt(object, "referencesPerNode", 1000); options.attribute_batch_size = GetUInt(object, "attributeBatchSize", 200);
  if (object.Has("namespaceIndexes") && object.Get("namespaceIndexes").IsArray()) { Napi::Array values = object.Get("namespaceIndexes").As<Napi::Array>(); for (uint32_t index = 0; index < values.Length(); ++index) options.namespaces.insert(static_cast<uint16_t>(values.Get(index).ToNumber().Uint32Value())); }
  auto deferred = Napi::Promise::Deferred::New(env); (new BrowseWorker(deferred, context, std::move(options)))->Queue(); return deferred.Promise();
}

Napi::Value CreateSubscriptionAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[1].IsObject() || !info[2].IsFunction()) return env.Undefined(); Napi::Object options = info[1].As<Napi::Object>(); auto deferred = Napi::Promise::Deferred::New(env);
  (new CreateSubscriptionWorker(deferred, context, info[2].As<Napi::Function>(), GetUInt(options, "callbackQueueSize", 10000), GetDouble(options, "publishingInterval", 1000), GetUInt(options, "lifetimeCount", 120), GetUInt(options, "maxKeepAliveCount", 10), GetUInt(options, "maxNotificationsPerPublish", 0), GetUInt(options, "callbackBatchSize", 500), GetString(options, "queueMode", "all"), GetString(options, "overflowPolicy", "drop-oldest")))->Queue(); return deferred.Promise();
}

Napi::Value AddMonitoredItemsAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[2].IsArray()) return env.Undefined(); uint32_t subscription_id = info[1].ToNumber().Uint32Value(); Napi::Array array = info[2].As<Napi::Array>(); Napi::Object defaults = info.Length() > 3 && info[3].IsObject() ? info[3].As<Napi::Object>() : Napi::Object::New(env); std::vector<MonitorInput> inputs;
  for (uint32_t index = 0; index < array.Length(); ++index) { Napi::Object object = array.Get(index).As<Napi::Object>(); MonitorInput input; input.node_id = GetString(object, "nodeId"); input.sampling_interval = GetDouble(object, "samplingInterval", GetDouble(defaults, "samplingInterval", 1000)); input.queue_size = GetUInt(object, "queueSize", GetUInt(defaults, "queueSize", 10)); input.discard_oldest = GetBool(object, "discardOldest", GetBool(defaults, "discardOldest", true)); input.deadband_type = GetString(object, "deadbandType", GetString(defaults, "deadbandType", "none")); input.deadband_value = GetDouble(object, "deadbandValue", GetDouble(defaults, "deadbandValue", 0)); inputs.push_back(std::move(input)); }
  std::string timestamp_mode = GetString(defaults, "timestampMode", "source");
  UA_TimestampsToReturn timestamps_to_return = timestamp_mode == "both" ? UA_TIMESTAMPSTORETURN_BOTH :
      (timestamp_mode == "server" ? UA_TIMESTAMPSTORETURN_SERVER :
      (timestamp_mode == "neither" ? UA_TIMESTAMPSTORETURN_NEITHER : UA_TIMESTAMPSTORETURN_SOURCE));
  auto deferred = Napi::Promise::Deferred::New(env); (new AddMonitoredWorker(deferred, context, subscription_id, std::move(inputs), timestamps_to_return))->Queue(); return deferred.Promise();
}

Napi::Value RemoveMonitoredItemsAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[2].IsArray()) return env.Undefined(); Napi::Array array = info[2].As<Napi::Array>(); std::vector<uint32_t> ids; for (uint32_t index = 0; index < array.Length(); ++index) ids.push_back(array.Get(index).ToNumber().Uint32Value()); auto deferred = Napi::Promise::Deferred::New(env); (new RemoveMonitoredWorker(deferred, context, info[1].ToNumber().Uint32Value(), std::move(ids)))->Queue(); return deferred.Promise();
}

Napi::Value DeleteSubscriptionAsync(const Napi::CallbackInfo& info) { Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context) return env.Undefined(); auto deferred = Napi::Promise::Deferred::New(env); (new DeleteSubscriptionWorker(deferred, context, info[1].ToNumber().Uint32Value()))->Queue(); return deferred.Promise(); }

Napi::Value ValidateSubscriptionAsync(const Napi::CallbackInfo& info) { Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context) return env.Undefined(); auto deferred = Napi::Promise::Deferred::New(env); (new ValidateSubscriptionWorker(deferred, context, info[1].ToNumber().Uint32Value()))->Queue(); return deferred.Promise(); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("connectAsync", Napi::Function::New(env, ConnectAsync)); exports.Set("disconnectAsync", Napi::Function::New(env, DisconnectAsync));
  exports.Set("discoverEndpointsAsync", Napi::Function::New(env, DiscoverEndpointsAsync));
  exports.Set("getClientDiagnostics", Napi::Function::New(env, GetClientDiagnostics));
  exports.Set("browseAsync", Napi::Function::New(env, BrowseAsync)); exports.Set("readManyAsync", Napi::Function::New(env, ReadManyAsync)); exports.Set("writeManyAsync", Napi::Function::New(env, WriteManyAsync));
  exports.Set("createSubscriptionAsync", Napi::Function::New(env, CreateSubscriptionAsync)); exports.Set("addMonitoredItemsAsync", Napi::Function::New(env, AddMonitoredItemsAsync)); exports.Set("removeMonitoredItemsAsync", Napi::Function::New(env, RemoveMonitoredItemsAsync)); exports.Set("deleteSubscriptionAsync", Napi::Function::New(env, DeleteSubscriptionAsync)); exports.Set("validateSubscriptionAsync", Napi::Function::New(env, ValidateSubscriptionAsync));
  return exports;
}

}  // namespace

NODE_API_MODULE(opcua_open62541, Init)
