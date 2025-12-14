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
  };

  robotWs.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'hello') {
        robotWsStatus.value = '已连接';
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
        video: { deviceId: { exact: devId } },
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
</style>
