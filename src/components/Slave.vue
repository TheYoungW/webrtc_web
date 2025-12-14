<template>
  <div class="slave-container">
    <div class="card setup-panel" v-if="!isCallActive">
      <div class="header">
        <h2>操作臂设置</h2>
        <div class="status-indicators">
          <span class="status-badge" :class="{ connected: signalingStatus === '已连接' }">
            <span class="status-dot"></span>
            服务器: {{ signalingStatus }}
          </span>
          <span class="status-badge" :class="{ connected: robotWsStatus === '已连接' }">
            <span class="status-dot"></span>
            机器人: {{ robotWsStatus }}
          </span>
        </div>
      </div>

      <div class="form-group">
        <label>设备 ID</label>
        <input v-model="deviceId" placeholder="输入设备 ID" :disabled="signalingStatus === '已连接'" style="width: 100%; padding: 0.8rem; margin-bottom: 1rem; border-radius: 12px; border: 1px solid rgba(0,0,0,0.1);" />
        <button class="primary full-width" @click="connectServer" :disabled="signalingStatus === '已连接'">
          {{ signalingStatus === '已连接' ? '服务器已连接' : '连接服务器' }}
        </button>
      </div>

      <div class="form-group">
        <label>机器人串口</label>
        <select v-model="selectedDeviceId" :disabled="isRobotBusy || robotConnected" style="width: 100%; padding: 0.8rem; margin-bottom: 0.75rem; border-radius: 12px; border: 1px solid rgba(0,0,0,0.1);">
          <option value="" disabled>请选择串口</option>
          <option v-for="d in robotDevices" :key="d.device_id + '_' + d.driver_type" :value="d.device_id">
            {{ d.device_id }}（{{ d.driver_type }}）
          </option>
        </select>
        <div style="display:flex; gap: 12px;">
          <button class="full-width" @click="fetchRobotInfos" :disabled="isRobotBusy || robotConnected">
            刷新设备
          </button>
          <button class="primary full-width" @click="connectRobot" :disabled="isRobotBusy || robotConnected || !selectedDeviceId || !selectedDriverType">
            {{ robotConnected ? '已连接' : '连接机器人' }}
          </button>
        </div>
      </div>

      <div class="form-group">
        <label>摄像头源 (最多选3个)</label>
        <div class="checkbox-group">
          <div v-for="device in videoDevices" :key="device.deviceId" class="checkbox-item">
            <input type="checkbox" :id="device.deviceId" :value="device.deviceId" v-model="selectedDeviceIds" :disabled="selectedDeviceIds.length >= 3 && !selectedDeviceIds.includes(device.deviceId)">
            <label :for="device.deviceId">{{ device.label || 'Camera ' + device.deviceId.substr(0, 8) }}</label>
          </div>
        </div>
      </div>

      <div class="call-status" v-if="incomingCall">
        <div class="incoming-alert">
          <div class="caller-info">
            <span class="caller-label">来电请求</span>
            <span class="caller-id">{{ incomingCallSender }}</span>
          </div>
          <button class="primary accept-btn" @click="acceptCall">
            接听
          </button>
        </div>
      </div>
      <div class="waiting-state" v-else>
        <div class="spinner"></div>
        <p>等待连接...</p>
      </div>
    </div>

    <div class="video-wrapper card" v-show="isCallActive">
      <video ref="localVideo" autoplay playsinline muted></video>
      <div class="overlay-status">
        <span class="status-badge connected">实时</span>
      </div>
    </div>

    <!-- 操作臂：连接成功后的数据显示 & 统计 -->
    <div class="card exec-panel" v-show="isCallActive">
      <div class="header">
        <h2>操作臂数据面板</h2>
        <div class="status-indicators">
          <span class="status-badge" :class="{ connected: robotWsStatus === '已连接' }">
            <span class="status-dot"></span>
            机器人: {{ robotWsStatus }}
          </span>
        </div>
      </div>

      <div class="exec-stats" v-if="rxStats.frames > 0">
        <div class="exec-stats-title">实时统计（DataChannel 接收）</div>
        <div class="exec-stats-grid">
          <div class="exec-stats-item"><span>FPS</span><b>{{ rxStats.fps.toFixed(1) }}</b></div>
          <div class="exec-stats-item"><span>Δt P50</span><b>{{ rxStats.dtP50Ms.toFixed(1) }} ms</b></div>
          <div class="exec-stats-item"><span>Δt P95</span><b>{{ rxStats.dtP95Ms.toFixed(1) }} ms</b></div>
          <div class="exec-stats-item"><span>Δt P99</span><b>{{ rxStats.dtP99Ms.toFixed(1) }} ms</b></div>
          <div class="exec-stats-item"><span>已接收帧</span><b>{{ rxStats.frames }}</b></div>
          <div class="exec-stats-item"><span>总接收量</span><b>{{ formatBytes(rxStats.totalBytes) }}</b></div>
        </div>
      </div>

      <div v-if="robotLastState" class="robot-state">
        <div class="robot-state-title">机器人状态（get.state）</div>
        <pre class="robot-state-pre">{{ JSON.stringify(robotLastState, null, 2) }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { WebRTCManager } from '../utils/webrtc';

const deviceId = ref('robot_01');
const selectedDeviceIds = ref([]);
const videoDevices = ref([]);
const status = ref('未连接');
const signalingStatus = ref('未连接');
const incomingCall = ref(false);
const incomingCallSender = ref('');
const isCallActive = ref(false);
const localVideo = ref(null);

let webrtc = null;
let robotWs = null;
let pendingOffer = null;
let robotStateTimer = null;

// -------------------- 操作臂：状态显示 --------------------
const robotLastState = ref(null);

// -------------------- Control-first：视频限速/降优先级（让控制数据更稳） --------------------
// 总视频上行预算（多个摄像头会均分）；按需调整
const VIDEO_TOTAL_MAX_KBPS = 1200; // 1.2 Mbps total
const VIDEO_MAX_FPS = 20;

async function applyControlFirstVideoPolicy(pc) {
  try {
    const senders = pc?.getSenders ? pc.getSenders() : [];
    const videoSenders = senders.filter(s => s?.track?.kind === 'video');
    if (!videoSenders.length) return;

    const perTrackBps = Math.floor((VIDEO_TOTAL_MAX_KBPS * 1000) / videoSenders.length);

    for (const sender of videoSenders) {
      try {
        const params = sender.getParameters ? sender.getParameters() : {};
        // encodings 为空时需要补一个，否则 setParameters 可能失败
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];

        // 限制码率：拥塞时优先牺牲视频
        params.encodings[0].maxBitrate = perTrackBps;

        // 限制帧率（不同浏览器支持情况不同）
        params.encodings[0].maxFramerate = VIDEO_MAX_FPS;

        // 尝试设置低优先级（Chrome 支持较好；不支持会被忽略或抛错）
        params.encodings[0].priority = 'very-low';
        params.encodings[0].networkPriority = 'low';

        await sender.setParameters(params);
      } catch (e) {
        // 浏览器不支持某些字段时，忽略即可
        console.warn('[webrtc] set video sender parameters failed', e);
      }
    }
  } catch (e) {
    console.warn('[webrtc] applyControlFirstVideoPolicy failed', e);
  }
}

// -------------------- 统计：DataChannel 接收 --------------------
const _enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
const rxTotalBytes = ref(0);
const rxFrames = ref(0);
const _rxFrameTimesMs = [];
const _rxDeltaMs = [];
const rxStats = ref({
  fps: 0,
  dtP50Ms: 0,
  dtP95Ms: 0,
  dtP99Ms: 0,
  frames: 0,
  totalBytes: 0,
});

function _percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Math.max(0, bytes);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function _updateRxStats() {
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  while (_rxFrameTimesMs.length && now - _rxFrameTimesMs[0] > 1000) _rxFrameTimesMs.shift();
  const fps = _rxFrameTimesMs.length;

  const tail = _rxDeltaMs.slice(-300);
  const sorted = tail.slice().sort((a, b) => a - b);
  rxStats.value = {
    fps,
    dtP50Ms: _percentile(sorted, 0.50),
    dtP95Ms: _percentile(sorted, 0.95),
    dtP99Ms: _percentile(sorted, 0.99),
    frames: rxFrames.value,
    totalBytes: rxTotalBytes.value,
  };
}

function _recordRxFrame(dataStr) {
  const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  if (_rxFrameTimesMs.length) {
    const dt = now - _rxFrameTimesMs[_rxFrameTimesMs.length - 1];
    if (Number.isFinite(dt) && dt >= 0) _rxDeltaMs.push(dt);
    if (_rxDeltaMs.length > 1000) _rxDeltaMs.splice(0, _rxDeltaMs.length - 1000);
  }
  _rxFrameTimesMs.push(now);
  rxFrames.value += 1;

  let bytes = 0;
  if (_enc) bytes = _enc.encode(dataStr).length;
  else bytes = (dataStr || '').length;
  rxTotalBytes.value += bytes;
  _updateRxStats();
}

const API_BASE = 'http://127.0.0.1:8000';
const WS_BASE = 'ws://127.0.0.1:8000';

const robotDevices = ref([]); // [{ device_id, driver_type, ... }]
const selectedDeviceId = ref('');
const robotWsStatus = ref('未连接');
const robotConnected = ref(false);
const isRobotBusy = ref(false);

const selectedDriverType = computed(() => {
  const d = robotDevices.value.find(x => x.device_id === selectedDeviceId.value);
  return d?.driver_type || '';
});

onMounted(async () => {
  await getCameras();

  webrtc = new WebRTCManager(deviceId.value, 'wss://rtc.sparklingrobo.com/signaling', 'EXECUTION_ARM');
  
  webrtc.onSignalingOpen = () => { signalingStatus.value = '已连接'; };
  webrtc.onSignalingClose = () => { signalingStatus.value = '未连接'; };
  webrtc.onSignalingError = (err) => { 
    signalingStatus.value = '错误'; 
    status.value = err || '连接错误';
  };

  // Override handleOffer
  const originalHandleOffer = webrtc.handleOffer.bind(webrtc);
  webrtc.handleOffer = async (msg) => {
    console.log("Received offer from", msg.from);
    pendingOffer = msg;
    incomingCallSender.value = msg.from;
    incomingCall.value = true;
  };

  webrtc.onDataChannelMessage = (data) => {
    // 操作臂：收到示教臂数据 -> 先打印 -> 再执行（转发给后端 /robots/ws/{device_id}）
    console.log("[webrtc] rx:", data);
    _recordRxFrame(data);

    // 兼容：Master 可能直接发 cmd.movej / cmd.ik 等；也可能发 state（这里转换成 cmd.movej）
    let out = data;
    try {
      const msg = JSON.parse(data);

      if (msg?.type === "state" && Array.isArray(msg?.joints_deg)) {
        out = JSON.stringify({
          type: "cmd.movej",
          joints_deg: msg.joints_deg,
          gripper: msg.gripper ?? 0.0,
          speed: msg.speed ?? 30.0,
          src: msg.src ?? "teaching_arm",
          ts: msg.ts ?? Date.now() / 1000,
        });
      } else {
        // 保持原样（cmd.* / ingest / ping 等）
        out = JSON.stringify(msg);
      }
    } catch {
      // 非 JSON 文本：原样透传
      out = data;
    }

    if (robotWs && robotWs.readyState === WebSocket.OPEN) {
      robotWs.send(out);
    } else {
      console.warn("robot ws not ready, drop webrtc data");
    }
  };

  // 进入页面先拉一次设备列表，方便直接选择串口
  fetchRobotInfos();
});

const connectServer = () => {
  signalingStatus.value = '连接中...';
  // Update ID in case user changed it
  if (webrtc) {
    webrtc.myId = deviceId.value;
  }
  webrtc.connectSignaling();
};


onUnmounted(() => {
  if (robotStateTimer) {
    try { clearInterval(robotStateTimer); } catch {}
    robotStateTimer = null;
  }
  if (robotWs) robotWs.close();
});

const getCameras = async () => {
  try {
    await navigator.mediaDevices.getUserMedia({ video: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    videoDevices.value = devices.filter(d => d.kind === 'videoinput');
    if (videoDevices.value.length > 0) {
      // Default select the first camera
      selectedDeviceIds.value = [videoDevices.value[0].deviceId];
    }
  } catch (e) {
    console.error("Error getting cameras:", e);
  }
};

const fetchRobotInfos = async () => {
  isRobotBusy.value = true;
  try {
    const res = await fetch(`${API_BASE}/robots/infos?timeout=3.0`, { method: 'GET' });
    if (!res.ok) throw new Error(`infos 请求失败: ${res.status}`);
    const data = await res.json();
    const wrapper = data?.devices ?? data;
    const list = wrapper?.devices ?? [];
    robotDevices.value = Array.isArray(list) ? list : [];
    if (!selectedDeviceId.value && robotDevices.value.length > 0) {
      selectedDeviceId.value = robotDevices.value[0].device_id;
    }
  } catch (e) {
    console.error(e);
    robotDevices.value = [];
    selectedDeviceId.value = '';
  } finally {
    isRobotBusy.value = false;
  }
};

const connectRobot = async () => {
  if (!selectedDeviceId.value || !selectedDriverType.value) return;
  isRobotBusy.value = true;
  robotWsStatus.value = '连接中...';
  try {
    const res = await fetch(`${API_BASE}/robots/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        arm_type: selectedDriverType.value,
        device_id: selectedDeviceId.value,
      })
    });
    if (!res.ok) throw new Error(`connect 请求失败: ${res.status}`);
    await res.json();
    robotConnected.value = true;
    await connectRobotWs(selectedDeviceId.value);
  } catch (e) {
    console.error(e);
    robotConnected.value = false;
    robotWsStatus.value = '错误';
  } finally {
    isRobotBusy.value = false;
  }
};

const connectRobotWs = async (devicePath) => {
  if (robotWs) {
    try { robotWs.close(); } catch {}
    robotWs = null;
  }

  // 注意：device_id 类似 "/dev/cu.xxx"，拼接后会出现双斜杠，符合后端 {device_id:path} 的用法
  const wsUrl = `${WS_BASE}/robots/ws/${devicePath}`;
  robotWs = new WebSocket(wsUrl);

  robotWs.onopen = () => {
    // 按要求：先发 ping，等 hello
    robotWsStatus.value = '握手中...';
    robotWs.send(JSON.stringify({ type: 'ping' }));
  };

  robotWs.onerror = (err) => {
    console.error('robot ws error', err);
    robotWsStatus.value = '错误';
  };

  robotWs.onclose = () => {
    robotWsStatus.value = '未连接';
    robotConnected.value = false;
    if (robotStateTimer) {
      try { clearInterval(robotStateTimer); } catch {}
      robotStateTimer = null;
    }
  };

  robotWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'hello') {
        robotWsStatus.value = '已连接';
        // 连接成功后：轮询 state 用于显示（默认 10Hz，避免影响执行）
        try { robotWs.send(JSON.stringify({ type: 'get.state' })); } catch {}
        if (robotStateTimer) {
          try { clearInterval(robotStateTimer); } catch {}
          robotStateTimer = null;
        }
        robotStateTimer = setInterval(() => {
          if (robotWs && robotWs.readyState === WebSocket.OPEN) {
            robotWs.send(JSON.stringify({ type: 'get.state' }));
          }
        }, Math.round(1000 / 10));
        return;
      }
      if (msg.type === 'state') {
        robotLastState.value = msg;
        return;
      }
    } catch {
      // ignore
    }
  };
};

const acceptCall = async () => {
  if (!pendingOffer) return;
  
  status.value = '连接中...';
  isCallActive.value = true;
  incomingCall.value = false;

  // Get streams for all selected cameras
  const streams = [];
  for (const devId of selectedDeviceIds.value) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // Control-first：在采集侧就限制分辨率/帧率，减少视频对带宽的压力
        video: {
          deviceId: { exact: devId },
          width: { ideal: 640 },
          height: { ideal: 360 },
          frameRate: { ideal: 15, max: VIDEO_MAX_FPS },
        },
        audio: false
      });
      streams.push(stream);
    } catch (e) {
      console.error(`Failed to get stream for device ${devId}:`, e);
    }
  }

  try {
    if (streams.length > 0) {
      // Show the first stream locally for now, or maybe a grid later
      webrtc.setLocalStream(streams[0]);
      if (localVideo.value) {
        localVideo.value.srcObject = streams[0];
      }
    }
    
    // Re-implement logic since we can't easily call original bound method in this context
    webrtc.targetId = pendingOffer.from;
    webrtc.createPeerConnection();
    
    // Add tracks from ALL streams
    streams.forEach(stream => {
      stream.getTracks().forEach(track => {
        webrtc.pc.addTrack(track, stream);
      });
    });

    // Control-first：把视频发送端限速 + 降优先级（避免视频挤占控制数据）
    await applyControlFirstVideoPolicy(webrtc.pc);

    const offerDesc = new RTCSessionDescription({
      type: 'offer',
      sdp: pendingOffer.data.sdp
    });

    await webrtc.pc.setRemoteDescription(offerDesc);
    const answer = await webrtc.pc.createAnswer();
    await webrtc.pc.setLocalDescription(answer);

    webrtc.sendSignalingMessage({
      type: 'answer',
      data: {
        type: 'answer',
        sdp: answer.sdp
      },
      target: webrtc.targetId
    });

    status.value = '已连接';

  } catch (e) {
    console.error(e);
    status.value = '错误';
    isCallActive.value = false;
  }
};
</script>

<style scoped>
.slave-container {
  width: 100%;
  max-width: 600px;
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.setup-panel {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
}

.select-wrapper select {
  width: 100%;
}

.waiting-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 32px 0;
  color: var(--text-secondary);
}

.spinner {
  width: 24px;
  height: 24px;
  border: 3px solid rgba(0, 0, 0, 0.1);
  border-top-color: var(--accent-color);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.incoming-alert {
  background: rgba(0, 113, 227, 0.05);
  border: 1px solid rgba(0, 113, 227, 0.1);
  border-radius: 12px;
  padding: 16px;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.caller-info {
  display: flex;
  flex-direction: column;
}

.caller-label {
  font-size: 12px;
  color: var(--accent-color);
  font-weight: 600;
}

.caller-id {
  font-weight: 600;
  font-size: 16px;
}

.video-wrapper {
  padding: 0;
  overflow: hidden;
  background: #000;
  aspect-ratio: 16/9;
  position: relative;
}

video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
}

.overlay-status {
  position: absolute;
  top: 16px;
  left: 16px;
}

.exec-panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.exec-stats {
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(0, 0, 0, 0.02);
}

.exec-stats-title {
  font-size: 0.85rem;
  color: #666;
  margin-bottom: 8px;
}

.exec-stats-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px 10px;
}

.exec-stats-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: #fff;
  border: 1px solid rgba(0, 0, 0, 0.06);
}

.exec-stats-item span {
  color: #666;
  font-size: 12px;
}

.exec-stats-item b {
  font-size: 12px;
  font-weight: 700;
  color: #111;
}

.robot-state {
  padding-top: 4px;
}

.robot-state-title {
  font-size: 0.85rem;
  color: #666;
  margin-bottom: 8px;
}

.robot-state-pre {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  background: rgba(0, 0, 0, 0.04);
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.35;
}
</style>
