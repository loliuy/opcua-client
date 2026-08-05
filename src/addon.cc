#include <napi.h>

#include <open62541/client.h>
#include <open62541/client_config_default.h>
#include <open62541/client_highlevel.h>
#include <open62541/client_subscriptions.h>
#include <open62541/nodeids.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <deque>
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
    if (type == &UA_TYPES[UA_TYPES_INT64]) return Napi::Number::New(env, static_cast<double>(*static_cast<const UA_Int64*>(data)));
    if (type == &UA_TYPES[UA_TYPES_UINT64]) return Napi::Number::New(env, static_cast<double>(*static_cast<const UA_UInt64*>(data)));
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
  if (name == "SByte") { UA_SByte value = static_cast<UA_SByte>(input.ToNumber().Int32Value()); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Byte") { UA_Byte value = static_cast<UA_Byte>(input.ToNumber().Uint32Value()); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Int16") { UA_Int16 value = static_cast<UA_Int16>(input.ToNumber().Int32Value()); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "UInt16") { UA_UInt16 value = static_cast<UA_UInt16>(input.ToNumber().Uint32Value()); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Int32") { UA_Int32 value = input.ToNumber().Int32Value(); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "UInt32") { UA_UInt32 value = input.ToNumber().Uint32Value(); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "Int64") { bool lossless = false; UA_Int64 value = input.IsBigInt() ? input.As<Napi::BigInt>().Int64Value(&lossless) : static_cast<UA_Int64>(input.ToNumber().Int64Value()); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
  if (name == "UInt64") { bool lossless = false; UA_UInt64 value = input.IsBigInt() ? input.As<Napi::BigInt>().Uint64Value(&lossless) : static_cast<UA_UInt64>(input.ToNumber().Int64Value()); return UA_StatusCode_isGood(UA_Variant_setScalarCopy(output, &value, type)); }
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
};

struct SubscriptionContext {
  uint32_t subscription_id = 0;
  std::shared_ptr<NotificationQueue> notifications;
  std::map<uint32_t, std::unique_ptr<MonitoredContext>> monitored;
};

struct OperationLimits {
  uint32_t max_nodes_per_read = 0;
  uint32_t max_nodes_per_write = 0;
  uint32_t max_nodes_per_browse = 0;
  uint32_t max_monitored_items_per_call = 0;
};

struct CachedNodeId {
  UA_NodeId value;
  CachedNodeId() { UA_NodeId_init(&value); }
  ~CachedNodeId() { UA_NodeId_clear(&value); }
  CachedNodeId(const CachedNodeId&) = delete;
  CachedNodeId& operator=(const CachedNodeId&) = delete;
};

struct ClientContext {
  UA_Client* client = nullptr;
  std::atomic<bool> running{false};
  std::thread iterate_thread;
  std::mutex mutex;
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
  constexpr size_t count = 4;
  const UA_UInt32 node_ids[count] = {
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXNODESPERREAD,
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXNODESPERWRITE,
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXNODESPERBROWSE,
      UA_NS0ID_SERVER_SERVERCAPABILITIES_OPERATIONLIMITS_MAXMONITOREDITEMSPERCALL};
  uint32_t* targets[count] = {
      &context->operation_limits.max_nodes_per_read,
      &context->operation_limits.max_nodes_per_write,
      &context->operation_limits.max_nodes_per_browse,
      &context->operation_limits.max_monitored_items_per_call};
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
        *targets[index] = *static_cast<UA_UInt32*>(value.value.data);
      }
    }
  }
  UA_ReadResponse_clear(&response);
}

std::mutex clients_mutex;
std::map<uint64_t, std::shared_ptr<ClientContext>> clients;
std::atomic<uint64_t> next_client_id{1};

std::shared_ptr<ClientContext> FindClient(uint64_t client_id) {
  std::lock_guard<std::mutex> lock(clients_mutex);
  auto found = clients.find(client_id);
  return found == clients.end() ? nullptr : found->second;
}

void Iterate(ClientContext* context) {
  while (context->running.load()) {
    {
      std::lock_guard<std::mutex> lock(context->mutex);
      if (!context->client) return;
      UA_Client_run_iterate(context->client, 20);
      if (context->force_secure_channel_reconnect.exchange(false)) {
        UA_Client_disconnectSecureChannelAsync(context->client);
      }
      if (context->refresh_operation_limits.exchange(false) &&
          context->session_state.load() == UA_SESSIONSTATE_ACTIVATED) {
        ReadOperationLimits(context);
      }
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
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
  context->running.store(false);
  if (context->iterate_thread.joinable()) context->iterate_thread.join();
  std::lock_guard<std::mutex> lock(context->mutex);
  for (auto& entry : context->subscriptions) CloseNotificationQueue(entry.second->notifications);
  context->subscriptions.clear();
  if (context->client) {
    UA_Client_disconnect(context->client);
    UA_Client_delete(context->client);
    context->client = nullptr;
  }
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

struct ConnectionOptions {
  std::string endpoint;
  std::string security_mode;
  std::string security_policy;
  std::string user;
  std::string password;
  uint32_t timeout = 10000;
  uint32_t session_timeout = 60000;
  uint32_t connectivity_check_interval = 5000;
  uint32_t node_id_cache_size = 100000;
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
    if (!options_.security_mode.empty() && options_.security_mode != "None") {
      SetError("Sign and SignAndEncrypt require an encryption-enabled open62541 build"); return;
    }
    context_ = std::make_shared<ClientContext>();
    context_->state_callback = state_callback_;
    context_->has_state_callback.store(has_state_callback_);
    context_->client = UA_Client_new();
    if (!context_->client) { SetError("Failed to create open62541 client"); return; }
    UA_ClientConfig* config = UA_Client_getConfig(context_->client);
    UA_ClientConfig_setDefault(config);
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
      UA_Client_delete(context_->client); context_->client = nullptr; return;
    }
    context_->node_id_cache_capacity = options_.node_id_cache_size;
    ReadOperationLimits(context_.get());
    context_->refresh_operation_limits.store(false);
    client_id_ = next_client_id.fetch_add(1);
    context_->running.store(true);
    context_->iterate_thread = std::thread(Iterate, context_.get());
    std::lock_guard<std::mutex> lock(clients_mutex);
    clients[client_id_] = context_;
  }
  void OnOK() override { deferred_.Resolve(Napi::Number::New(Env(), static_cast<double>(client_id_))); }
  void OnError(const Napi::Error& error) override {
    if (has_state_callback_ && !transferred_) state_callback_.Release();
    PromiseWorker::OnError(error);
  }
 private:
  ConnectionOptions options_;
  std::shared_ptr<ClientContext> context_;
  Napi::ThreadSafeFunction state_callback_;
  bool has_state_callback_ = false;
  bool transferred_ = false;
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

class ReadManyWorker : public PromiseWorker {
 public:
  ReadManyWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                 std::vector<std::string> node_ids)
      : PromiseWorker(deferred), context_(std::move(context)), node_ids_(std::move(node_ids)) {
    UA_ReadResponse_init(&response_);
  }
  ~ReadManyWorker() override { UA_ReadResponse_clear(&response_); }
  void Execute() override {
    UA_ReadRequest request;
    UA_ReadRequest_init(&request);
    request.timestampsToReturn = UA_TIMESTAMPSTORETURN_BOTH;
    request.nodesToReadSize = node_ids_.size();
    request.nodesToRead = static_cast<UA_ReadValueId*>(UA_Array_new(node_ids_.size(), &UA_TYPES[UA_TYPES_READVALUEID]));
    if (!request.nodesToRead) { SetError("Failed to allocate batch read request"); return; }
    for (size_t index = 0; index < node_ids_.size(); ++index) {
      if (!CopyCachedNodeId(context_.get(), node_ids_[index], &request.nodesToRead[index].nodeId)) {
        UA_ReadRequest_clear(&request); SetError("Invalid NodeId: " + node_ids_[index]); return;
      }
      request.nodesToRead[index].attributeId = UA_ATTRIBUTEID_VALUE;
    }
    {
      std::lock_guard<std::mutex> lock(context_->mutex);
      if (!context_->client) { UA_ReadRequest_clear(&request); SetError("Client disconnected"); return; }
      response_ = UA_Client_Service_read(context_->client, request);
    }
    UA_ReadRequest_clear(&request);
    if (!UA_StatusCode_isGood(response_.responseHeader.serviceResult)) {
      SetError("Batch read failed: " + StatusName(response_.responseHeader.serviceResult));
    }
  }
  void OnOK() override {
    Napi::Array output = Napi::Array::New(Env(), node_ids_.size());
    for (size_t index = 0; index < node_ids_.size(); ++index) {
      Napi::Object item = Napi::Object::New(Env());
      item.Set("nodeId", node_ids_[index]);
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
  std::shared_ptr<ClientContext> context_;
  std::vector<std::string> node_ids_;
  UA_ReadResponse response_;
};

struct WriteInput {
  std::string node_id;
  std::string data_type;
  UA_Variant value;
  WriteInput() { UA_Variant_init(&value); }
  ~WriteInput() { UA_Variant_clear(&value); }
};

class WriteManyWorker : public PromiseWorker {
 public:
  WriteManyWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                  std::vector<std::unique_ptr<WriteInput>> inputs)
      : PromiseWorker(deferred), context_(std::move(context)), inputs_(std::move(inputs)) {
    UA_WriteResponse_init(&response_);
  }
  ~WriteManyWorker() override { UA_WriteResponse_clear(&response_); }
  void Execute() override {
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
      target.value.hasValue = true;
      UA_Variant_copy(&inputs_[index]->value, &target.value.value);
    }
    {
      std::lock_guard<std::mutex> lock(context_->mutex);
      if (!context_->client) { UA_WriteRequest_clear(&request); SetError("Client disconnected"); return; }
      response_ = UA_Client_Service_write(context_->client, request);
    }
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
      item.Set("statusCode", index < response_.resultsSize ? StatusName(response_.results[index]) : "BadUnexpectedError");
      output.Set(index, item);
    }
    deferred_.Resolve(output);
  }
 private:
  std::shared_ptr<ClientContext> context_;
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
  uint32_t attribute_batch_size = 200;
  std::set<uint16_t> namespaces;
};

class BrowseWorker : public PromiseWorker {
 public:
  BrowseWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
               BrowseOptions options)
      : PromiseWorker(deferred), context_(std::move(context)), options_(std::move(options)) {}
  void Execute() override {
    UA_NodeId root;
    UA_NodeId_init(&root);
    if (!CopyCachedNodeId(context_.get(), options_.root_node_id, &root)) { SetError("Invalid root NodeId: " + options_.root_node_id); return; }
    UA_NodeId_clear(&root);
    std::lock_guard<std::mutex> lock(context_->mutex);
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
    deferred_.Resolve(output);
  }
 private:
  struct QueueItem { std::string node_id; std::string path; uint32_t depth; };

  bool NamespaceAllowed(uint16_t value) const { return options_.namespaces.empty() || options_.namespaces.count(value) > 0; }

  void ProcessBrowseResult(const QueueItem& parent, const UA_BrowseResult& result,
                           std::deque<QueueItem>* queue, std::set<std::string>* visited) {
    for (size_t index = 0; index < result.referencesSize && points_.size() < options_.max_nodes; ++index) {
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
      if (options_.recursive && parent.depth < options_.max_depth && visited->insert(node_id_text).second) {
        queue->push_back({node_id_text, path, parent.depth + 1});
      }
    }
  }

  bool BrowseTree() {
    std::deque<QueueItem> queue{{options_.root_node_id, "", 0}};
    std::set<std::string> visited{options_.root_node_id};
    while (!queue.empty() && points_.size() < options_.max_nodes) {
      QueueItem current = std::move(queue.front()); queue.pop_front();
      UA_BrowseRequest request; UA_BrowseRequest_init(&request);
      request.requestedMaxReferencesPerNode = 1000;
      request.nodesToBrowseSize = 1;
      request.nodesToBrowse = static_cast<UA_BrowseDescription*>(UA_Array_new(1, &UA_TYPES[UA_TYPES_BROWSEDESCRIPTION]));
      if (!request.nodesToBrowse || !CopyCachedNodeId(context_.get(), current.node_id, &request.nodesToBrowse[0].nodeId)) {
        UA_BrowseRequest_clear(&request); SetError("Invalid browse NodeId: " + current.node_id); return false;
      }
      auto& description = request.nodesToBrowse[0];
      description.browseDirection = UA_BROWSEDIRECTION_FORWARD;
      description.referenceTypeId = UA_NODEID_NUMERIC(0, UA_NS0ID_HIERARCHICALREFERENCES);
      description.includeSubtypes = true;
      description.nodeClassMask = UA_NODECLASS_OBJECT | UA_NODECLASS_VARIABLE;
      description.resultMask = UA_BROWSERESULTMASK_ALL;
      UA_BrowseResponse response = UA_Client_Service_browse(context_->client, request);
      UA_BrowseRequest_clear(&request);
      if (!UA_StatusCode_isGood(response.responseHeader.serviceResult)) {
        UA_BrowseResponse_clear(&response); SetError("Browse failed: " + StatusName(response.responseHeader.serviceResult)); return false;
      }
      if (response.resultsSize) {
        ProcessBrowseResult(current, response.results[0], &queue, &visited);
        UA_ByteString continuation = UA_BYTESTRING_NULL;
        UA_ByteString_copy(&response.results[0].continuationPoint, &continuation);
        while (continuation.length && points_.size() < options_.max_nodes) {
          UA_BrowseNextRequest next; UA_BrowseNextRequest_init(&next);
          next.continuationPointsSize = 1;
          next.continuationPoints = static_cast<UA_ByteString*>(UA_Array_new(1, &UA_TYPES[UA_TYPES_BYTESTRING]));
          UA_ByteString_copy(&continuation, &next.continuationPoints[0]);
          UA_ByteString_clear(&continuation);
          UA_BrowseNextResponse next_response = UA_Client_Service_browseNext(context_->client, next);
          UA_BrowseNextRequest_clear(&next);
          if (!UA_StatusCode_isGood(next_response.responseHeader.serviceResult) || !next_response.resultsSize) {
            UA_BrowseNextResponse_clear(&next_response); break;
          }
          ProcessBrowseResult(current, next_response.results[0], &queue, &visited);
          UA_ByteString_copy(&next_response.results[0].continuationPoint, &continuation);
          UA_BrowseNextResponse_clear(&next_response);
        }
        UA_ByteString_clear(&continuation);
      }
      UA_BrowseResponse_clear(&response);
    }
    return true;
  }

  void ReadAttributes() {
    const size_t attrs = 5;
    size_t batch = std::max<size_t>(1, options_.attribute_batch_size) * attrs;
    uint32_t read_limit = context_->operation_limits.max_nodes_per_read;
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

  std::shared_ptr<ClientContext> context_;
  BrowseOptions options_;
  std::vector<BrowsePoint> points_;
};

class CreateSubscriptionWorker : public PromiseWorker {
 public:
  CreateSubscriptionWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                           Napi::Function callback, uint32_t queue_size, double publishing_interval,
                           uint32_t lifetime, uint32_t keepalive, uint32_t max_notifications,
                           uint32_t callback_batch_size, std::string queue_mode,
                           std::string overflow_policy)
      : PromiseWorker(deferred), context_(std::move(context)), publishing_interval_(publishing_interval),
        lifetime_(lifetime), keepalive_(keepalive), max_notifications_(max_notifications),
        queue_size_(std::max<uint32_t>(1, queue_size)),
        callback_batch_size_(std::max<uint32_t>(1, callback_batch_size)),
        queue_mode_(queue_mode == "latest" ? "latest" : "all"),
        overflow_policy_(overflow_policy == "drop-newest" ? "drop-newest" : "drop-oldest") {
    callback_ = Napi::ThreadSafeFunction::New(Env(), callback, "OpcUaDataChangeBatches", 1, 1);
  }
  void Execute() override {
    UA_CreateSubscriptionRequest request = UA_CreateSubscriptionRequest_default();
    request.requestedPublishingInterval = publishing_interval_;
    request.requestedLifetimeCount = lifetime_;
    request.requestedMaxKeepAliveCount = keepalive_;
    request.maxNotificationsPerPublish = max_notifications_;
    std::lock_guard<std::mutex> lock(context_->mutex);
    if (!context_->client) { SetError("Client disconnected"); return; }
    UA_CreateSubscriptionResponse response = UA_Client_Subscriptions_create(context_->client, request, nullptr, nullptr, nullptr);
    status_ = response.responseHeader.serviceResult; subscription_id_ = response.subscriptionId;
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
  void OnOK() override { Napi::Object result = Napi::Object::New(Env()); result.Set("subscriptionId", subscription_id_); result.Set("statusCode", StatusName(status_)); deferred_.Resolve(result); }
  void OnError(const Napi::Error& error) override { if (!transferred_) callback_.Release(); PromiseWorker::OnError(error); }
 private:
  std::shared_ptr<ClientContext> context_; Napi::ThreadSafeFunction callback_; bool transferred_ = false;
  double publishing_interval_; uint32_t lifetime_; uint32_t keepalive_; uint32_t max_notifications_;
  uint32_t queue_size_; uint32_t callback_batch_size_; std::string queue_mode_; std::string overflow_policy_;
  uint32_t subscription_id_ = 0; UA_StatusCode status_ = UA_STATUSCODE_GOOD;
};

struct MonitorInput { std::string node_id; double sampling_interval; uint32_t queue_size; bool discard_oldest; std::string deadband_type; double deadband_value; };
struct MonitorResult { std::string node_id; uint32_t monitored_item_id = 0; UA_StatusCode status = UA_STATUSCODE_BADUNEXPECTEDERROR; };

class AddMonitoredWorker : public PromiseWorker {
 public:
  AddMonitoredWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                     uint32_t subscription_id, std::vector<MonitorInput> inputs)
      : PromiseWorker(deferred), context_(std::move(context)), subscription_id_(subscription_id), inputs_(std::move(inputs)) {}
  void Execute() override {
    std::lock_guard<std::mutex> lock(context_->mutex);
    auto subscription_it = context_->subscriptions.find(subscription_id_);
    if (!context_->client || subscription_it == context_->subscriptions.end()) { SetError("Subscription not found"); return; }
    auto* subscription = subscription_it->second.get();
    UA_CreateMonitoredItemsRequest request; UA_CreateMonitoredItemsRequest_init(&request);
    request.subscriptionId = subscription_id_; request.timestampsToReturn = UA_TIMESTAMPSTORETURN_BOTH;
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
      item.requestedParameters.clientHandle = static_cast<uint32_t>(index + 1);
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
      contexts[index] = std::make_unique<MonitoredContext>(); contexts[index]->notifications = subscription->notifications; contexts[index]->node_id = inputs_[index].node_id; context_ptrs[index] = contexts[index].get();
    }
    UA_CreateMonitoredItemsResponse response = UA_Client_MonitoredItems_createDataChanges(context_->client, request, context_ptrs.data(), callbacks.data(), nullptr);
    for (size_t index = 0; index < filters.size(); ++index) {
      if (filters[index]) UA_ExtensionObject_init(&request.itemsToCreate[index].requestedParameters.filter);
    }
    UA_CreateMonitoredItemsRequest_clear(&request);
    if (!UA_StatusCode_isGood(response.responseHeader.serviceResult)) { UA_CreateMonitoredItemsResponse_clear(&response); SetError("Create monitored items failed: " + StatusName(response.responseHeader.serviceResult)); return; }
    for (size_t index = 0; index < inputs_.size(); ++index) {
      MonitorResult result; result.node_id = inputs_[index].node_id;
      if (index < response.resultsSize) {
        result.status = response.results[index].statusCode; result.monitored_item_id = response.results[index].monitoredItemId;
        if (UA_StatusCode_isGood(result.status)) { contexts[index]->monitored_item_id = result.monitored_item_id; subscription->monitored[result.monitored_item_id] = std::move(contexts[index]); }
      }
      results_.push_back(result);
    }
    UA_CreateMonitoredItemsResponse_clear(&response);
  }
  void OnOK() override { Napi::Array output = Napi::Array::New(Env(), results_.size()); for (size_t index = 0; index < results_.size(); ++index) { Napi::Object item = Napi::Object::New(Env()); item.Set("nodeId", results_[index].node_id); item.Set("monitoredItemId", results_[index].monitored_item_id); item.Set("statusCode", StatusName(results_[index].status)); output.Set(index, item); } deferred_.Resolve(output); }
 private:
  std::shared_ptr<ClientContext> context_; uint32_t subscription_id_; std::vector<MonitorInput> inputs_; std::vector<MonitorResult> results_;
};

class RemoveMonitoredWorker : public PromiseWorker {
 public:
  RemoveMonitoredWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context,
                        uint32_t subscription_id, std::vector<uint32_t> ids)
      : PromiseWorker(deferred), context_(std::move(context)), subscription_id_(subscription_id), ids_(std::move(ids)) { UA_DeleteMonitoredItemsResponse_init(&response_); }
  ~RemoveMonitoredWorker() override { UA_DeleteMonitoredItemsResponse_clear(&response_); }
  void Execute() override {
    std::lock_guard<std::mutex> lock(context_->mutex); auto sub = context_->subscriptions.find(subscription_id_);
    if (!context_->client || sub == context_->subscriptions.end()) { SetError("Subscription not found"); return; }
    UA_DeleteMonitoredItemsRequest request; UA_DeleteMonitoredItemsRequest_init(&request); request.subscriptionId = subscription_id_; request.monitoredItemIdsSize = ids_.size(); request.monitoredItemIds = static_cast<UA_UInt32*>(UA_Array_new(ids_.size(), &UA_TYPES[UA_TYPES_UINT32]));
    std::copy(ids_.begin(), ids_.end(), request.monitoredItemIds); response_ = UA_Client_MonitoredItems_delete(context_->client, request); UA_DeleteMonitoredItemsRequest_clear(&request);
    if (!UA_StatusCode_isGood(response_.responseHeader.serviceResult)) { SetError("Delete monitored items failed: " + StatusName(response_.responseHeader.serviceResult)); return; }
    for (size_t index = 0; index < ids_.size() && index < response_.resultsSize; ++index) if (UA_StatusCode_isGood(response_.results[index])) sub->second->monitored.erase(ids_[index]);
  }
  void OnOK() override { Napi::Array output = Napi::Array::New(Env(), ids_.size()); for (size_t index = 0; index < ids_.size(); ++index) { Napi::Object item = Napi::Object::New(Env()); item.Set("monitoredItemId", ids_[index]); item.Set("statusCode", index < response_.resultsSize ? StatusName(response_.results[index]) : "BadUnexpectedError"); output.Set(index, item); } deferred_.Resolve(output); }
 private:
  std::shared_ptr<ClientContext> context_; uint32_t subscription_id_; std::vector<uint32_t> ids_; UA_DeleteMonitoredItemsResponse response_;
};

class ValidateSubscriptionWorker : public PromiseWorker {
 public:
  ValidateSubscriptionWorker(Napi::Promise::Deferred deferred,
                             std::shared_ptr<ClientContext> context, uint32_t id)
      : PromiseWorker(deferred), context_(std::move(context)), id_(id) {}
  void Execute() override {
    std::lock_guard<std::mutex> lock(context_->mutex);
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
  std::shared_ptr<ClientContext> context_;
  uint32_t id_;
  UA_StatusCode status_ = UA_STATUSCODE_GOOD;
};

class DeleteSubscriptionWorker : public PromiseWorker {
 public:
  DeleteSubscriptionWorker(Napi::Promise::Deferred deferred, std::shared_ptr<ClientContext> context, uint32_t id)
      : PromiseWorker(deferred), context_(std::move(context)), id_(id) {}
  void Execute() override { std::lock_guard<std::mutex> lock(context_->mutex); auto found = context_->subscriptions.find(id_); if (found == context_->subscriptions.end()) return; status_ = context_->client ? UA_Client_Subscriptions_deleteSingle(context_->client, id_) : UA_STATUSCODE_BADCONNECTIONCLOSED; CloseNotificationQueue(found->second->notifications); context_->subscriptions.erase(found); if (!UA_StatusCode_isGood(status_)) SetError("Delete subscription failed: " + StatusName(status_)); }
  void OnOK() override { Napi::Object result = Napi::Object::New(Env()); result.Set("subscriptionId", id_); result.Set("statusCode", StatusName(status_)); deferred_.Resolve(result); }
 private:
  std::shared_ptr<ClientContext> context_; uint32_t id_; UA_StatusCode status_ = UA_STATUSCODE_GOOD;
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
  limits.Set("maxNodesPerRead", context->operation_limits.max_nodes_per_read);
  limits.Set("maxNodesPerWrite", context->operation_limits.max_nodes_per_write);
  limits.Set("maxNodesPerBrowse", context->operation_limits.max_nodes_per_browse);
  limits.Set("maxMonitoredItemsPerCall", context->operation_limits.max_monitored_items_per_call);
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
  result.Set("connection", connection);

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
  options.endpoint = GetString(object, "endpoint"); options.security_mode = GetString(object, "securityMode", "None"); options.security_policy = GetString(object, "securityPolicy", "None"); options.user = GetString(object, "user"); options.password = GetString(object, "password"); options.timeout = GetUInt(object, "requestTimeout", 10000); options.session_timeout = GetUInt(object, "requestedSessionTimeout", 60000); options.connectivity_check_interval = GetUInt(object, "connectivityCheckInterval", 5000); options.node_id_cache_size = GetUInt(object, "nodeIdCacheSize", 100000);
  bool has_state_callback = info.Length() > 1 && info[1].IsFunction();
  Napi::ThreadSafeFunction state_callback;
  if (has_state_callback) {
    state_callback = Napi::ThreadSafeFunction::New(
        env, info[1].As<Napi::Function>(), "OPC UA connection state", 64, 1);
  }
  auto deferred = Napi::Promise::Deferred::New(env); (new ConnectWorker(deferred, std::move(options), std::move(state_callback), has_state_callback))->Queue(); return deferred.Promise();
}

Napi::Value DisconnectAsync(const Napi::CallbackInfo& info) { Napi::Env env = info.Env(); uint64_t id = info[0].As<Napi::Number>().Int64Value(); auto deferred = Napi::Promise::Deferred::New(env); (new DisconnectWorker(deferred, id))->Queue(); return deferred.Promise(); }

Napi::Value ReadManyAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[1].IsArray()) return env.Undefined(); Napi::Array array = info[1].As<Napi::Array>(); std::vector<std::string> ids; ids.reserve(array.Length());
  for (uint32_t index = 0; index < array.Length(); ++index) { Napi::Value value = array.Get(index); ids.push_back(value.IsString() ? value.As<Napi::String>().Utf8Value() : GetString(value.As<Napi::Object>(), "nodeId")); }
  auto deferred = Napi::Promise::Deferred::New(env); (new ReadManyWorker(deferred, context, std::move(ids)))->Queue(); return deferred.Promise();
}

Napi::Value WriteManyAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[1].IsArray()) return env.Undefined(); Napi::Array array = info[1].As<Napi::Array>(); std::vector<std::unique_ptr<WriteInput>> inputs;
  for (uint32_t index = 0; index < array.Length(); ++index) { Napi::Object object = array.Get(index).As<Napi::Object>(); auto input = std::make_unique<WriteInput>(); input->node_id = GetString(object, "nodeId"); input->data_type = GetString(object, "dataType", "String"); if (!object.Has("value")) { Napi::TypeError::New(env, "Write point is missing value").ThrowAsJavaScriptException(); return env.Undefined(); } if (!JsScalarToVariant(env, object.Get("value"), input->data_type, &input->value)) return env.Undefined(); inputs.push_back(std::move(input)); }
  auto deferred = Napi::Promise::Deferred::New(env); (new WriteManyWorker(deferred, context, std::move(inputs)))->Queue(); return deferred.Promise();
}

Napi::Value BrowseAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[1].IsObject()) return env.Undefined(); Napi::Object object = info[1].As<Napi::Object>(); BrowseOptions options;
  options.root_node_id = GetString(object, "rootNodeId", "ns=0;i=85"); options.recursive = GetBool(object, "recursive", true); options.variables_only = GetBool(object, "variablesOnly", true); options.max_depth = GetUInt(object, "maxDepth", 10); options.max_nodes = GetUInt(object, "maxNodes", 10000); options.attribute_batch_size = GetUInt(object, "attributeBatchSize", 200);
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
  auto deferred = Napi::Promise::Deferred::New(env); (new AddMonitoredWorker(deferred, context, subscription_id, std::move(inputs)))->Queue(); return deferred.Promise();
}

Napi::Value RemoveMonitoredItemsAsync(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context || !info[2].IsArray()) return env.Undefined(); Napi::Array array = info[2].As<Napi::Array>(); std::vector<uint32_t> ids; for (uint32_t index = 0; index < array.Length(); ++index) ids.push_back(array.Get(index).ToNumber().Uint32Value()); auto deferred = Napi::Promise::Deferred::New(env); (new RemoveMonitoredWorker(deferred, context, info[1].ToNumber().Uint32Value(), std::move(ids)))->Queue(); return deferred.Promise();
}

Napi::Value DeleteSubscriptionAsync(const Napi::CallbackInfo& info) { Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context) return env.Undefined(); auto deferred = Napi::Promise::Deferred::New(env); (new DeleteSubscriptionWorker(deferred, context, info[1].ToNumber().Uint32Value()))->Queue(); return deferred.Promise(); }

Napi::Value ValidateSubscriptionAsync(const Napi::CallbackInfo& info) { Napi::Env env = info.Env(); auto context = RequireClient(env, info[0]); if (!context) return env.Undefined(); auto deferred = Napi::Promise::Deferred::New(env); (new ValidateSubscriptionWorker(deferred, context, info[1].ToNumber().Uint32Value()))->Queue(); return deferred.Promise(); }

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("connectAsync", Napi::Function::New(env, ConnectAsync)); exports.Set("disconnectAsync", Napi::Function::New(env, DisconnectAsync));
  exports.Set("getClientDiagnostics", Napi::Function::New(env, GetClientDiagnostics));
  exports.Set("browseAsync", Napi::Function::New(env, BrowseAsync)); exports.Set("readManyAsync", Napi::Function::New(env, ReadManyAsync)); exports.Set("writeManyAsync", Napi::Function::New(env, WriteManyAsync));
  exports.Set("createSubscriptionAsync", Napi::Function::New(env, CreateSubscriptionAsync)); exports.Set("addMonitoredItemsAsync", Napi::Function::New(env, AddMonitoredItemsAsync)); exports.Set("removeMonitoredItemsAsync", Napi::Function::New(env, RemoveMonitoredItemsAsync)); exports.Set("deleteSubscriptionAsync", Napi::Function::New(env, DeleteSubscriptionAsync)); exports.Set("validateSubscriptionAsync", Napi::Function::New(env, ValidateSubscriptionAsync));
  return exports;
}

}  // namespace

NODE_API_MODULE(opcua_open62541, Init)
