#include <Arduino.h>
#include <WiFi.h>
#include <Wire.h>
#include <ArduinoJson.h>
#include <WebSocketsClient.h>
#include <esp_timer.h>
#include <esp_camera.h>
#include <esp_http_server.h>
#include <driver/mcpwm_prelude.h>
#include "config.h"
#include "water_adapter.h"
#if __has_include("secrets.h")
#include "secrets.h"
#else
#include "secrets.example.h"
#endif

// Servo control is the sole owner of PWM, on core 1 at higher priority than I/O.
// All handoffs are bounded: sensor latest=1, commands=8, acknowledgements=8.
static uint64_t uptimeMs() { return esp_timer_get_time()/1000ULL; }
struct ControlState {
  bool flapping=false, finAttached=false, syringeAttached=false, pwmFault=false, timeout=false;
  float amplitude=20, hz=0.5f, centre=135, left=NAN, right=NAN, syringe=NAN;
  uint64_t lastControl=0;
  uint32_t generation=0;
};
struct SensorSample { bool imuValid=false; float acceleration[3]={}, gyro[3]={}, roll=NAN, pitch=NAN; uint64_t sampled=0, waterSampled=0; WaterSample water; };
enum Action { START, STOP, SET_FIN, SET_SYRINGE };
struct Command { char id[65]={}, session[40]={}; Action action; float amplitude=0,hz=0,centre=0,target=0; uint64_t expires=0; uint32_t generation=0; };
struct Ack { char id[65]={}, session[40]={}; const char* status="rejected"; const char* reason="Invalid command"; };
static portMUX_TYPE stateMux=portMUX_INITIALIZER_UNLOCKED;
static ControlState control;
static QueueHandle_t sensorQueue, commandQueue, ackQueue;
static SemaphoreHandle_t cameraMutex;
static bool cameraReady=false;
static uint32_t cameraFailures=0, servedFrames=0;
static float cameraFps=NAN;
static ControlState controlCopy() { portENTER_CRITICAL(&stateMux); auto s=control; portEXIT_CRITICAL(&stateMux); return s; }

struct ServoOutput { mcpwm_oper_handle_t oper=nullptr; mcpwm_cmpr_handle_t comparator=nullptr; mcpwm_gen_handle_t generator=nullptr; };
static mcpwm_timer_handle_t servoTimer=nullptr;
static ServoOutput leftOutput,rightOutput,syringeOutput;
static bool initTimer() {
  if (servoTimer) return true;
  mcpwm_timer_config_t conf={}; conf.group_id=0; conf.clk_src=MCPWM_TIMER_CLK_SRC_DEFAULT; conf.resolution_hz=1000000; conf.period_ticks=20000; conf.count_mode=MCPWM_TIMER_COUNT_MODE_UP;
  return mcpwm_new_timer(&conf,&servoTimer)==ESP_OK && mcpwm_timer_enable(servoTimer)==ESP_OK && mcpwm_timer_start_stop(servoTimer,MCPWM_TIMER_START_NO_STOP)==ESP_OK;
}
static bool attachOutput(ServoOutput& out,int pin,int pulse) {
  if (out.generator) return true;
  if (!initTimer()) return false;
  mcpwm_operator_config_t op={}; op.group_id=0;
  mcpwm_comparator_config_t cmp={}; cmp.flags.update_cmp_on_tez=true;
  mcpwm_generator_config_t gen={}; gen.gen_gpio_num=pin;
  if (mcpwm_new_operator(&op,&out.oper)!=ESP_OK || mcpwm_operator_connect_timer(out.oper,servoTimer)!=ESP_OK || mcpwm_new_comparator(out.oper,&cmp,&out.comparator)!=ESP_OK || mcpwm_comparator_set_compare_value(out.comparator,pulse)!=ESP_OK || mcpwm_new_generator(out.oper,&gen,&out.generator)!=ESP_OK) return false;
  // Hold low until both fins have successfully initialized and a start is applied.
  if (mcpwm_generator_set_force_level(out.generator,0,true)!=ESP_OK) return false;
  return mcpwm_generator_set_action_on_timer_event(out.generator,MCPWM_GEN_TIMER_EVENT_ACTION(MCPWM_TIMER_DIRECTION_UP,MCPWM_TIMER_EVENT_EMPTY,MCPWM_GEN_ACTION_HIGH))==ESP_OK && mcpwm_generator_set_action_on_compare_event(out.generator,MCPWM_GEN_COMPARE_EVENT_ACTION(MCPWM_TIMER_DIRECTION_UP,out.comparator,MCPWM_GEN_ACTION_LOW))==ESP_OK;
}
static int finPulse(float deg) { return lroundf(Config::FIN_MIN_US+(Config::FIN_MAX_US-Config::FIN_MIN_US)*deg/Config::FIN_TRAVEL_DEG); }
static bool finBounds(float a,float hz,float centre) {
  return isfinite(a)&&isfinite(hz)&&isfinite(centre)&&a>=0&&a<=Config::AMP_MAX&&hz>=Config::HZ_MIN&&hz<=Config::HZ_MAX&&centre>=Config::CENTRE_MIN&&centre<=Config::CENTRE_MAX&&centre-a+min(Config::LEFT_TRIM_DEG,Config::RIGHT_TRIM_DEG)>=Config::FIN_MIN_DEG&&centre+a+max(Config::LEFT_TRIM_DEG,Config::RIGHT_TRIM_DEG)<=Config::FIN_MAX_DEG;
}
static void servoTask(void*) {
  ControlState local; TickType_t wake=xTaskGetTickCount(); uint64_t last=uptimeMs(); float phase=0;
  for (;;) {
    auto shared=controlCopy(); local.lastControl=shared.lastControl; local.generation=shared.generation;
    uint64_t now=uptimeMs(); float dt=(now-last)/1000.0f; last=now;
    if (Config::STOP_ON_TIMEOUT && local.flapping && (!local.lastControl || now-local.lastControl>Config::HEARTBEAT_TIMEOUT_MS)) { local.flapping=false; local.timeout=true; }
    Command c;
    if (xQueueReceive(commandQueue,&c,0)==pdTRUE) {
      Ack ack; strlcpy(ack.id,c.id,sizeof(ack.id)); strlcpy(ack.session,c.session,sizeof(ack.session));
      if (c.generation!=local.generation) ack.reason="Connection changed; command discarded";
      else if (now>=c.expires || c.expires>now+2000) { ack.status="expired"; ack.reason="Device uptime deadline expired"; }
      else if (c.action!=STOP && (!local.lastControl || now-local.lastControl>Config::HEARTBEAT_TIMEOUT_MS)) ack.reason="Control heartbeat expired";
      else if (c.action!=STOP && (!Config::FIN_OUTPUTS || local.pwmFault)) ack.reason="Outputs disabled or PWM fault";
      else {
        bool applied=true;
        if (c.action==STOP) local.flapping=false; // Hold last fin targets; not a power cutoff.
        if (c.action==SET_FIN) {
          if (!finBounds(c.amplitude,c.hz,c.centre)) { applied=false; ack.reason="Fin limits exceeded"; }
          else { local.amplitude=c.amplitude; local.hz=c.hz; local.centre=c.centre; }
        }
        if (c.action==START) {
          if (!finBounds(local.amplitude,local.hz,local.centre)) { applied=false; ack.reason="Invalid configured fin limits"; }
          else if (!attachOutput(leftOutput,Config::FIN_LEFT_PIN,finPulse(local.centre+Config::LEFT_TRIM_DEG)) || !attachOutput(rightOutput,Config::FIN_RIGHT_PIN,finPulse(local.centre+Config::RIGHT_TRIM_DEG))) { local.pwmFault=true; applied=false; ack.reason="MCPWM initialization failed"; }
          else {
            local.finAttached=true; local.left=local.centre+Config::LEFT_TRIM_DEG; local.right=local.centre+Config::RIGHT_TRIM_DEG;
            if (mcpwm_generator_set_force_level(leftOutput.generator,-1,true)!=ESP_OK || mcpwm_generator_set_force_level(rightOutput.generator,-1,true)!=ESP_OK) { local.pwmFault=true; applied=false; ack.reason="MCPWM enable failed"; }
            else { local.flapping=true; local.timeout=false; phase=0; }
          }
        }
        if (c.action==SET_SYRINGE) {
          if (!Config::SYRINGE_ENABLED || !isfinite(c.target) || c.target<Config::SYRINGE_MIN || c.target>Config::SYRINGE_MAX) { applied=false; ack.reason="Syringe disabled or target outside calibrated limits"; }
          else {
            int pulse=lroundf(Config::SYRINGE_MIN_US+(Config::SYRINGE_MAX_US-Config::SYRINGE_MIN_US)*c.target/Config::SYRINGE_TRAVEL);
            if (!attachOutput(syringeOutput,Config::SYRINGE_PIN,pulse) || mcpwm_comparator_set_compare_value(syringeOutput.comparator,pulse)!=ESP_OK || mcpwm_generator_set_force_level(syringeOutput.generator,-1,true)!=ESP_OK) { applied=false; local.pwmFault=true; ack.reason="Syringe PWM failed"; }
            else { local.syringe=c.target; local.syringeAttached=true; }
          }
        }
        if (applied) { ack.status="applied"; ack.reason=nullptr; }
      }
      // A full ACK queue drops the ACK, never blocks PWM; backend reports unknown outcome.
      xQueueSend(ackQueue,&ack,0);
    }
    if (local.flapping && !local.pwmFault) {
      phase=fmodf(phase+2*PI*local.hz*dt,2*PI);
      float offset=local.amplitude*sinf(phase);
      local.left=local.centre+Config::LEFT_TRIM_DEG+Config::LEFT_DIRECTION*offset;
      local.right=local.centre+Config::RIGHT_TRIM_DEG+Config::RIGHT_DIRECTION*offset;
      if (mcpwm_comparator_set_compare_value(leftOutput.comparator,finPulse(local.left))!=ESP_OK || mcpwm_comparator_set_compare_value(rightOutput.comparator,finPulse(local.right))!=ESP_OK) { local.pwmFault=true; local.flapping=false; }
    }
    portENTER_CRITICAL(&stateMux); local.lastControl=control.lastControl; local.generation=control.generation; control=local; portEXIT_CRITICAL(&stateMux);
    vTaskDelayUntil(&wake,pdMS_TO_TICKS(10));
  }
}

// Camera SCCB port is selected by the prebuilt core; always use the other controller.
static TwoWire imuBus(Config::IMU_I2C_PORT);
static bool imuWrite(uint8_t reg,uint8_t value) { imuBus.beginTransmission(Config::IMU_ADDRESS); imuBus.write(reg); imuBus.write(value); return imuBus.endTransmission()==0; }
static bool imuRead(uint8_t reg,uint8_t* data,uint8_t count) {
  imuBus.beginTransmission(Config::IMU_ADDRESS); imuBus.write(reg);
  if (imuBus.endTransmission(false)!=0 || imuBus.requestFrom(Config::IMU_ADDRESS,count)!=count) return false;
  for (int i=0;i<count;i++) data[i]=imuBus.read(); return true;
}
static void sensorTask(void*) {
  imuBus.begin(Config::IMU_SDA,Config::IMU_SCL,400000); imuBus.setTimeOut(10);
  bool ready=false; uint64_t retry=0; SensorSample sample; TickType_t wake=xTaskGetTickCount();
  for (;;) {
    uint64_t now=uptimeMs();
    if (!ready && now>=retry) {
      uint8_t who=0; ready=imuRead(0x75,&who,1)&&who==0x68&&imuWrite(0x6B,0x01)&&imuWrite(0x1A,0x03)&&imuWrite(0x19,9)&&imuWrite(0x1B,0)&&imuWrite(0x1C,0); retry=now+2000;
    }
    uint8_t bytes[14]; sample.imuValid=ready&&imuRead(0x3B,bytes,14); sample.sampled=now;
    if (sample.imuValid) {
      for (int i=0;i<3;i++) { int16_t a=(bytes[2*i]<<8)|bytes[2*i+1], g=(bytes[8+2*i]<<8)|bytes[9+2*i]; sample.acceleration[i]=a/16384.0f*9.80665f-Config::ACCEL_BIAS[i]; sample.gyro[i]=g/131.0f-Config::GYRO_BIAS[i]; }
      // Gravity-only estimates, not navigation attitude; dynamic acceleration biases these.
      float x=sample.acceleration[0],y=sample.acceleration[1],z=sample.acceleration[2];
      float norm=sqrtf(x*x+y*y+z*z);
      sample.roll=norm>1?atan2f(y,z)*180/PI:NAN; sample.pitch=norm>1?atan2f(-x,sqrtf(y*y+z*z))*180/PI:NAN;
    } else { ready=false; sample.roll=sample.pitch=NAN; }
    if (now-sample.waterSampled>=Config::WATER_MS) { sample.water=readWaterAdapter(); sample.waterSampled=now; }
    xQueueOverwrite(sensorQueue,&sample); vTaskDelayUntil(&wake,pdMS_TO_TICKS(Config::SENSOR_MS));
  }
}

static bool initCamera() {
  if (!psramFound()) return false;
  camera_config_t c={}; c.ledc_channel=LEDC_CHANNEL_0; c.ledc_timer=LEDC_TIMER_0;
  c.pin_d0=Config::CAM_D0;c.pin_d1=Config::CAM_D1;c.pin_d2=Config::CAM_D2;c.pin_d3=Config::CAM_D3;c.pin_d4=Config::CAM_D4;c.pin_d5=Config::CAM_D5;c.pin_d6=Config::CAM_D6;c.pin_d7=Config::CAM_D7;
  c.pin_xclk=Config::CAM_XCLK;c.pin_pclk=Config::CAM_PCLK;c.pin_vsync=Config::CAM_VSYNC;c.pin_href=Config::CAM_HREF;c.pin_sccb_sda=Config::CAM_SDA;c.pin_sccb_scl=Config::CAM_SCL;c.pin_pwdn=Config::CAM_PWDN;c.pin_reset=Config::CAM_RESET;
  c.xclk_freq_hz=20000000;c.pixel_format=PIXFORMAT_JPEG;c.frame_size=FRAMESIZE_QVGA;c.jpeg_quality=Config::CAMERA_JPEG_QUALITY;c.fb_count=2;c.grab_mode=CAMERA_GRAB_LATEST;c.fb_location=CAMERA_FB_IN_PSRAM;
  return esp_camera_init(&c)==ESP_OK;
}
static esp_err_t cameraRequest(httpd_req_t* req) {
  bool stream=strcmp(req->uri,"/stream")==0;
  httpd_resp_set_type(req,stream?"multipart/x-mixed-replace;boundary=frame":"image/jpeg"); httpd_resp_set_hdr(req,"Cache-Control","no-store");
  esp_err_t result=ESP_OK;
  do {
    if (xSemaphoreTake(cameraMutex,pdMS_TO_TICKS(1000))!=pdTRUE) { if (!stream) { httpd_resp_set_status(req,"503 Service Unavailable");httpd_resp_sendstr(req,"Camera busy"); } return ESP_FAIL; }
    bool ready; portENTER_CRITICAL(&stateMux); ready=cameraReady; portEXIT_CRITICAL(&stateMux);
    camera_fb_t* fb=ready?esp_camera_fb_get():nullptr;
    if (!fb || fb->len>262144) {
      if (fb) esp_camera_fb_return(fb);
      portENTER_CRITICAL(&stateMux); cameraFailures++; portEXIT_CRITICAL(&stateMux);
      xSemaphoreGive(cameraMutex); if (!stream) { httpd_resp_set_status(req,"503 Service Unavailable");httpd_resp_sendstr(req,"Camera capture failed"); } return ESP_FAIL;
    }
    uint64_t timestamp=uint64_t(fb->timestamp.tv_sec)*1000ULL+fb->timestamp.tv_usec/1000ULL;
    char stamp[32]; snprintf(stamp,sizeof(stamp),"%llu",(unsigned long long)timestamp);
    if (stream) {
      char header[160]; int n=snprintf(header,sizeof(header),"\r\n--frame\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\nX-Capture-Uptime-Ms: %s\r\n\r\n",unsigned(fb->len),stamp);
      result=httpd_resp_send_chunk(req,header,n); if (result==ESP_OK) result=httpd_resp_send_chunk(req,reinterpret_cast<const char*>(fb->buf),fb->len);
    } else { httpd_resp_set_hdr(req,"X-Capture-Uptime-Ms",stamp); result=httpd_resp_send(req,reinterpret_cast<const char*>(fb->buf),fb->len); }
    esp_camera_fb_return(fb);
    portENTER_CRITICAL(&stateMux); if (result==ESP_OK) { servedFrames++; cameraFailures=0; } portEXIT_CRITICAL(&stateMux);
    xSemaphoreGive(cameraMutex);
    if (stream && result==ESP_OK) vTaskDelay(pdMS_TO_TICKS(Config::CAMERA_STREAM_INTERVAL_MS));
  } while (stream && result==ESP_OK && WiFi.status()==WL_CONNECTED);
  return result;
}
static bool startCameraServer(uint16_t port,const char* uri) {
  httpd_config_t cfg=HTTPD_DEFAULT_CONFIG(); cfg.server_port=port; cfg.ctrl_port=32768+port; cfg.stack_size=8192; cfg.core_id=0; cfg.max_open_sockets=2; cfg.lru_purge_enable=true; cfg.send_wait_timeout=2; cfg.recv_wait_timeout=2;
  httpd_handle_t handle=nullptr; if (httpd_start(&handle,&cfg)!=ESP_OK) return false;
  httpd_uri_t route={}; route.uri=uri;route.method=HTTP_GET;route.handler=cameraRequest;
  if (httpd_register_uri_handler(handle,&route)!=ESP_OK) { httpd_stop(handle); return false; } return true;
}
static void cameraTask(void*) {
  bool initialized=false, servers=false; uint64_t retry=0,lastFps=uptimeMs(); uint32_t previous=0;
  for (;;) {
    uint64_t now=uptimeMs(); uint32_t failures;
    portENTER_CRITICAL(&stateMux); failures=cameraFailures; portEXIT_CRITICAL(&stateMux);
    if ((!initialized||failures>=3) && now>=retry && xSemaphoreTake(cameraMutex,pdMS_TO_TICKS(100))==pdTRUE) {
      portENTER_CRITICAL(&stateMux); cameraReady=false; portEXIT_CRITICAL(&stateMux);
      if (initialized) esp_camera_deinit(); initialized=initCamera();
      portENTER_CRITICAL(&stateMux); cameraFailures=0; cameraReady=initialized&&servers; portEXIT_CRITICAL(&stateMux);
      retry=now+5000; xSemaphoreGive(cameraMutex);
    }
    if (!servers && WiFi.status()==WL_CONNECTED) { // independent listeners: stalled MJPEG cannot block a snapshot or telemetry.
      static bool snapshotStarted=false,streamStarted=false;
      if (!snapshotStarted) snapshotStarted=startCameraServer(80,"/capture");
      if (!streamStarted) streamStarted=startCameraServer(81,"/stream");
      servers=snapshotStarted&&streamStarted;
      portENTER_CRITICAL(&stateMux); cameraReady=initialized&&servers; portEXIT_CRITICAL(&stateMux);
    }
    if (now-lastFps>=2000) {
      portENTER_CRITICAL(&stateMux); cameraFps=(servedFrames-previous)*1000.0f/(now-lastFps); previous=servedFrames; portEXIT_CRITICAL(&stateMux); lastFps=now;
    }
    vTaskDelay(pdMS_TO_TICKS(100));
  }
}

static WebSocketsClient webSocket;
static char sessionId[40]={}; static uint32_t reconnects=0,backoff=500; static uint64_t lastServerBeat=0;
static char seenIds[64][65]={}; static size_t nextId=0;
static void numberReading(JsonObject parent,const char* key,float value,const char* unit,const char* reason) {
  auto r=parent[key].to<JsonObject>(); r["unit"]=unit; if (isfinite(value)) { r["value"]=value; r["reason"]=nullptr; } else { r["value"]=nullptr; r["reason"]=reason; }
}
static void vectorReading(JsonObject parent,const char* key,const float* values,const char* unit,bool valid) {
  auto r=parent[key].to<JsonObject>(); r["unit"]=unit;
  if (valid) { auto a=r["value"].to<JsonArray>(); for (int i=0;i<3;i++) a.add(values[i]); r["reason"]=nullptr; }
  else { r["value"]=nullptr; r["reason"]="MPU6050 unavailable or stale"; }
}
static void sendAck(const Ack& ack) {
  if (!sessionId[0] || strcmp(sessionId,ack.session)!=0) return;
  JsonDocument d; d["schema_version"]=1;d["type"]="ack";d["id"]=ack.id;d["session_id"]=ack.session;d["status"]=ack.status;d["reason"]=ack.reason;
  String payload;serializeJson(d,payload);webSocket.sendTXT(payload);
}
static bool realNumber(JsonVariantConst v) { return v.is<float>() && !v.is<bool>() && isfinite(v.as<float>()); }
static void webSocketEvent(WStype_t type,uint8_t* payload,size_t length) {
  if (type==WStype_CONNECTED) {
    JsonDocument d; d["type"]="hello";d["schema_version"]=1;d["robot_id"]=ROBOT_ID;d["source"]="hardware";d["token"]=DEVICE_TOKEN;String message;serializeJson(d,message);webSocket.sendTXT(message); lastServerBeat=uptimeMs();
  }
  if (type==WStype_DISCONNECTED) {
    sessionId[0]=0; reconnects++; portENTER_CRITICAL(&stateMux); control.generation++; portEXIT_CRITICAL(&stateMux); xQueueReset(commandQueue);xQueueReset(ackQueue);
    backoff=min(uint32_t(10000),backoff*2);webSocket.setReconnectInterval(backoff+esp_random()%250);
  }
  if (type!=WStype_TEXT) return;
  if (length>4096) { webSocket.disconnect(); return; }
  JsonDocument d; if (deserializeJson(d,payload,length)) { webSocket.disconnect(); return; }
  const char* kind=d["type"]|"";
  if (strcmp(kind,"welcome")==0 && d["schema_version"]==1 && d["session_id"].is<const char*>()) {
    const char* id=d["session_id"]; if (strlen(id)!=36) { webSocket.disconnect(); return; }
    strlcpy(sessionId,id,sizeof(sessionId)); memset(seenIds,0,sizeof(seenIds));nextId=0;backoff=500;webSocket.setReconnectInterval(backoff);lastServerBeat=uptimeMs();
    portENTER_CRITICAL(&stateMux);control.generation++;control.lastControl=0;portEXIT_CRITICAL(&stateMux); xQueueReset(commandQueue);xQueueReset(ackQueue); return;
  }
  const char* sid=d["session_id"]|"";
  if (!sessionId[0]||strcmp(sid,sessionId)!=0) return;
  if (strcmp(kind,"heartbeat")==0 && d["schema_version"]==1 && d["control_active"].is<bool>()) {
    lastServerBeat=uptimeMs();if (d["control_active"].as<bool>()) { portENTER_CRITICAL(&stateMux);control.lastControl=lastServerBeat;portEXIT_CRITICAL(&stateMux); }return;
  }
  if (strcmp(kind,"command")!=0) return;
  Ack rejected;const char* id=d["id"]|"";strlcpy(rejected.id,id,sizeof(rejected.id));strlcpy(rejected.session,sessionId,sizeof(rejected.session));
  if (strlen(id)<8||strlen(id)>64) return;
  for (const char* p=id;*p;p++) if (!(isalnum(static_cast<unsigned char>(*p))||*p=='_'||*p=='-')) return;
  for (auto& seen:seenIds) if (strcmp(seen,id)==0) { rejected.reason="Duplicate command; not replayed";sendAck(rejected);return; }
  if (d["schema_version"]!=1 || !d["ttl_ms"].is<unsigned>() || d["ttl_ms"].as<unsigned>()<200 || d["ttl_ms"].as<unsigned>()>2000 || !d["expires_uptime_ms"].is<uint64_t>() || !d["args"].is<JsonObject>()) { sendAck(rejected);return; }
  Command c;strlcpy(c.id,id,sizeof(c.id));strlcpy(c.session,sessionId,sizeof(c.session));c.expires=d["expires_uptime_ms"].as<uint64_t>();c.generation=controlCopy().generation;
  const char* action=d["action"]|"";JsonObjectConst args=d["args"].as<JsonObjectConst>();bool valid=true;
  if (strcmp(action,"start")==0) { c.action=START;valid=args.size()==0; }
  else if (strcmp(action,"stop")==0) { c.action=STOP;valid=args.size()==0; }
  else if (strcmp(action,"set_fin")==0) { c.action=SET_FIN;valid=args.size()==3&&realNumber(args["amplitude_deg"])&&realNumber(args["cycle_hz"])&&realNumber(args["centre_deg"]);c.amplitude=args["amplitude_deg"];c.hz=args["cycle_hz"];c.centre=args["centre_deg"];valid=valid&&finBounds(c.amplitude,c.hz,c.centre); }
  else if (strcmp(action,"set_syringe")==0) { c.action=SET_SYRINGE;valid=args.size()==1&&realNumber(args["target_deg"]);c.target=args["target_deg"];valid=valid&&c.target>=0&&c.target<=180; }
  else valid=false;
  if (!valid) { rejected.reason="Invalid command arguments or limits";sendAck(rejected);return; }
  strlcpy(seenIds[nextId++%64],id,65);
  if (xQueueSend(commandQueue,&c,0)!=pdTRUE) { rejected.reason="Command queue full";sendAck(rejected); }
}
static void publishTelemetry(uint64_t seq) {
  auto c=controlCopy();SensorSample s;xQueuePeek(sensorQueue,&s,0);uint64_t now=uptimeMs();bool imu=s.imuValid&&now-s.sampled<200,water=now-s.waterSampled<3000;
  bool cam;float fps;portENTER_CRITICAL(&stateMux);cam=cameraReady;fps=cameraFps;portEXIT_CRITICAL(&stateMux);
  JsonDocument d;d["schema_version"]=1;d["type"]="telemetry";d["robot_id"]=ROBOT_ID;d["firmware_version"]="esp32-1.0.0";d["seq"]=seq;d["uptime_ms"]=now;d["source"]="hardware";d["mode"]=Config::STOP_ON_TIMEOUT?"bench":"autonomous";
  numberReading(d.as<JsonObject>(),"device_time",NAN,"unix_ms","Clock not synchronized; use backend receive time");
  auto wifi=d["wifi"].to<JsonObject>();numberReading(wifi,"rssi",WiFi.RSSI(),"dBm","Wi-Fi disconnected");wifi["reconnects"]=reconnects;
  auto motion=d["imu"].to<JsonObject>();vectorReading(motion,"acceleration",s.acceleration,"m/s^2",imu);vectorReading(motion,"angular_velocity",s.gyro,"deg/s",imu);numberReading(motion,"roll_estimate",imu?s.roll:NAN,"deg","MPU6050 stale or gravity estimate unavailable");numberReading(motion,"pitch_estimate",imu?s.pitch:NAN,"deg","MPU6050 stale or gravity estimate unavailable");motion["calibration_state"]=imu?(Config::IMU_CALIBRATED?"configured":"uncalibrated"):"unavailable";
  auto w=d["water"].to<JsonObject>();numberReading(w,"temperature",water?s.water.temperature:NAN,"degC",water?s.water.temperatureReason:"Water sensor adapter stale");numberReading(w,"tds_raw",water?s.water.tdsRaw:NAN,"ADC_count",water?s.water.rawReason:"Water sensor adapter stale");numberReading(w,"tds_estimate",water&&s.water.calibrationId?s.water.tdsPpm:NAN,"ppm",water?s.water.ppmReason:"Water sensor adapter stale");w["calibration_id"]=s.water.calibrationId;
  auto ctl=d["control"].to<JsonObject>();ctl["flapping"]=c.flapping;ctl["outputs_enabled"]=Config::FIN_OUTPUTS&&!c.pwmFault;ctl["amplitude_deg"]=c.amplitude;ctl["cycle_hz"]=c.hz;ctl["centre_deg"]=c.centre;numberReading(ctl,"left_command",c.left,"deg","No fin output commanded since startup");numberReading(ctl,"right_command",c.right,"deg","No fin output commanded since startup");numberReading(ctl,"syringe_command",c.syringe,"deg",Config::SYRINGE_ENABLED?"No syringe command since startup":"Syringe model and calibration unconfirmed");ctl["actuator_state"]=Config::SYRINGE_ENABLED?"holding":"disabled";ctl["disconnect_policy"]=Config::STOP_ON_TIMEOUT?"stop":"continue";ctl["heartbeat_timeout_ms"]=Config::HEARTBEAT_TIMEOUT_MS;
  auto camera=d["camera"].to<JsonObject>();camera["available"]=cam;camera["reason"]=cam?nullptr:"Camera unavailable; initialization/capture retry pending";
  if (cam) { String base="http://"+WiFi.localIP().toString();camera["stream_url"]=base+":81/stream";camera["snapshot_url"]=base+"/capture"; } else { camera["stream_url"]=nullptr;camera["snapshot_url"]=nullptr; }
  numberReading(camera,"fps",cam?fps:NAN,"fps","No served-frame rate available");camera["calibration_id"]=Config::CAMERA_CALIBRATION_ID;
  auto faults=d["faults"].to<JsonArray>();if (!imu) faults.add("MPU6050 unavailable or stale");if (!cam) faults.add("Camera unavailable; retrying");if (!Config::FIN_OUTPUTS) faults.add("Fin outputs disabled pending calibration");if (c.pwmFault) faults.add("MCPWM fault; movement disabled");if (c.timeout) faults.add("Control heartbeat timed out; fins hold last target");
  String payload;payload.reserve(4096);serializeJson(d,payload);if (payload.length()<8192) webSocket.sendTXT(payload);
}
static void networkTask(void*) {
  WiFi.mode(WIFI_STA);WiFi.setAutoReconnect(false);WiFi.setSleep(false);
  webSocket.begin(BACKEND_HOST,BACKEND_PORT,"/ws/device");webSocket.onEvent(webSocketEvent);webSocket.setReconnectInterval(backoff);webSocket.enableHeartbeat(1000,2000,2);
  uint64_t nextWifi=0,lastPublish=0,seq=0;uint32_t wifiBackoff=5000;
  for (;;) {
    uint64_t now=uptimeMs();
    if (WiFi.status()!=WL_CONNECTED) {
      if (sessionId[0]) webSocket.disconnect();
      if (now>=nextWifi) { WiFi.begin(WIFI_SSID,WIFI_PASSWORD);nextWifi=now+wifiBackoff+esp_random()%500;wifiBackoff=min(uint32_t(30000),wifiBackoff*2); }
    } else {
      wifiBackoff=5000;webSocket.loop();
      if (sessionId[0]&&uptimeMs()-lastServerBeat>4000) webSocket.disconnect();
      Ack ack;while (xQueueReceive(ackQueue,&ack,0)==pdTRUE) sendAck(ack);
      if (sessionId[0]&&now-lastPublish>=Config::TELEMETRY_MS) { lastPublish=now;publishTelemetry(seq++); }
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}
void setup() {
  Serial.begin(115200);Serial.println("Manta Ray v1: outputs idle at boot; local telemetry only");
  pinMode(Config::FIN_LEFT_PIN,INPUT);pinMode(Config::FIN_RIGHT_PIN,INPUT); // no startup pulses
  sensorQueue=xQueueCreate(1,sizeof(SensorSample));commandQueue=xQueueCreate(8,sizeof(Command));ackQueue=xQueueCreate(8,sizeof(Ack));cameraMutex=xSemaphoreCreateMutex();
  if (!sensorQueue||!commandQueue||!ackQueue||!cameraMutex) { Serial.println("Queue allocation failed; stopped");return; }
  if (xTaskCreatePinnedToCore(servoTask,"fin-control",6144,nullptr,4,nullptr,1)!=pdPASS) { Serial.println("Control task failed; stopped");return; }
  xTaskCreatePinnedToCore(sensorTask,"sensors",4096,nullptr,2,nullptr,1);
  xTaskCreatePinnedToCore(cameraTask,"camera",6144,nullptr,1,nullptr,0);
  xTaskCreatePinnedToCore(networkTask,"network",12288,nullptr,1,nullptr,0);
}
void loop() { delay(1000); }
