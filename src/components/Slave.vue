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
          <span class="status-badge" :class="{ connected: driverStatus.includes('Connected') }">
            <span class="status-dot"></span>
            驱动
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
import { ref, onMounted, onUnmounted } from 'vue';
import { WebRTCManager } from '../utils/webrtc';

const deviceId = ref('robot_01');
const selectedDeviceIds = ref([]);
const videoDevices = ref([]);
const status = ref('未连接');
const signalingStatus = ref('未连接');
const driverStatus = ref('未连接');
const incomingCall = ref(false);
const incomingCallSender = ref('');
const isCallActive = ref(false);
const localVideo = ref(null);

let webrtc = null;
let driverWs = null;
let pendingOffer = null;

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
    if (driverWs && driverWs.readyState === WebSocket.OPEN) {
      driverWs.send(data);
    }
  };

  // connectDriver(); // Disabled for video testing
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
  if (driverWs) driverWs.close();
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

const connectDriver = () => {
  driverWs = new WebSocket('ws://localhost:8001');
  driverWs.onopen = () => { driverStatus.value = '已连接'; };
  driverWs.onclose = () => {
    driverStatus.value = '未连接';
    setTimeout(connectDriver, 2000);
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
