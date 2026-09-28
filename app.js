const DEFAULT_TARGET_FPS = 10;
const COMMAND_SIZE = 250;
const SERIAL_CHUNK_SIZE = 4096;
const ACK_TIMEOUT_MS = 8000;
const PROTOCOL = Object.freeze({
  markerA: 0xcf,
  markerB: 0xef,
  framebufferSize: 19,
  fullFrameAck: 21,
  frameDelta: 25,
  render: 23,
  renderAck: 24
});
const CRC16_TABLE = new Uint16Array(256);
for (let value = 0; value < CRC16_TABLE.length; value += 1) {
  let remainder = value;
  for (let bit = 0; bit < 8; bit += 1) {
    remainder = (remainder & 1) ? (remainder >>> 1) ^ 0xa001 : remainder >>> 1;
  }
  CRC16_TABLE[value] = remainder;
}

const displayCanvas = document.querySelector("#display-canvas");
const displayContext = displayCanvas.getContext("2d", { alpha: false });
const frameCanvas = document.createElement("canvas");
const frameContext = frameCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
const dashboardCanvas = document.createElement("canvas");
const dashboardContext = dashboardCanvas.getContext("2d", { alpha: false });
const captureVideo = document.querySelector("#capture-video");
const serialState = document.querySelector("#serial-state");
const serialStateLabel = document.querySelector("#serial-state-label");
const transferStatus = document.querySelector("#transfer-status");
const transferStatusRow = document.querySelector(".transfer-status");
const connectButton = document.querySelector("#connect-button");
const shareButton = document.querySelector("#share-button");
const resolutionSelect = document.querySelector("#resolution-select");
const baudSelect = document.querySelector("#baud-select");
const orientationSelect = document.querySelector("#orientation-select");
const pixelFormatSelect = document.querySelector("#pixel-format-select");
const byteOrderSelect = document.querySelector("#byte-order-select");
const byteOrderField = document.querySelector("#byte-order-field");
const brightnessSlider = document.querySelector("#brightness-slider");
const brightnessOutput = document.querySelector("#brightness-output");
const previewResolution = document.querySelector("#preview-resolution");
const screenFrame = document.querySelector("#screen-frame");
const previewRate = document.querySelector("#preview-rate");
const lastSent = document.querySelector("#last-sent");
const dashboardModeButton = document.querySelector("#dashboard-mode");
const sharedModeButton = document.querySelector("#shared-mode");
const testPatternButton = document.querySelector("#test-pattern-button");
const pushFrameButton = document.querySelector("#push-frame-button");
const autoSyncToggle = document.querySelector("#auto-sync-toggle");
const targetFpsSlider = document.querySelector("#target-fps-slider");
const targetFpsOutput = document.querySelector("#target-fps-output");

let port = null;
let writer = null;
let reader = null;
let readLoopTask = null;
let captureStream = null;
let previousFrame = null;
let sendBusy = false;
let forceKeyFrame = true;
let pendingBrightness = null;
let lastFrameSentAt = 0;
let frameCount = 0;
let frameStartedAt = performance.now();
let latestFrameBytes = 0;
let targetGeneration = 0;
let currentBaudRate = 115200;
let testPatternActive = false;
let pendingTestPattern = false;
let pendingManualPush = false;
let autoSyncEnabled = false;
let activeSendSource = "manual";
let activeDeviceProfileKey = null;
const ackWaiters = new Map();

function setStatus(message, state = "idle") {
  transferStatus.textContent = message;
  transferStatusRow.dataset.state = state;
}

function setSerialState(state, label) {
  serialState.dataset.state = state;
  serialStateLabel.textContent = label;
}

function deviceProfileKey(selectedPort) {
  const { vendorId, productId } = selectedPort.getInfo();
  if (!Number.isInteger(vendorId) || !Number.isInteger(productId)) return null;
  return `turmo-display-settings-${vendorId.toString(16)}-${productId.toString(16)}`;
}

function saveDeviceSettings() {
  if (!activeDeviceProfileKey) return;
  const settings = {
    resolution: resolutionSelect.value,
    baudRate: baudSelect.value,
    orientation: orientationSelect.value,
    pixelFormat: pixelFormatSelect.value,
    byteOrder: byteOrderSelect.value,
    brightness: Number(brightnessSlider.value),
    targetFps: Number(targetFpsSlider.value)
  };
  try {
    localStorage.setItem(activeDeviceProfileKey, JSON.stringify(settings));
  } catch {
    // Settings remain usable for this session if browser storage is unavailable.
  }
}

function restoreDeviceSettings() {
  if (!activeDeviceProfileKey) return;
  let settings;
  try {
    settings = JSON.parse(localStorage.getItem(activeDeviceProfileKey));
  } catch {
    return;
  }
  if (!settings || typeof settings !== "object") return;

  for (const [select, value] of [
    [resolutionSelect, settings.resolution],
    [baudSelect, settings.baudRate],
    [orientationSelect, settings.orientation],
    [pixelFormatSelect, settings.pixelFormat],
    [byteOrderSelect, settings.byteOrder]
  ]) {
    if ([...select.options].some((option) => option.value === value)) select.value = value;
  }
  if (Number.isInteger(settings.brightness) && settings.brightness >= 0 && settings.brightness <= 255) {
    brightnessSlider.value = settings.brightness;
    brightnessOutput.value = String(settings.brightness);
    brightnessOutput.textContent = String(settings.brightness);
  }
  if (Number.isInteger(settings.targetFps) && settings.targetFps >= 1 && settings.targetFps <= 15) {
    targetFpsSlider.value = settings.targetFps;
    targetFpsOutput.value = String(settings.targetFps);
    targetFpsOutput.textContent = String(settings.targetFps);
  }
  byteOrderField.hidden = pixelFormatSelect.value !== "rgb565";
  resizeCanvases();
}

function getTargetIntervalMs() {
  return 1000 / Math.max(1, Number(targetFpsSlider.value) || DEFAULT_TARGET_FPS);
}

function makeCommand(command, value = null) {
  const packet = new Uint8Array(COMMAND_SIZE);
  packet[0] = command;
  packet[1] = PROTOCOL.markerA;
  packet[2] = PROTOCOL.markerB;
  if (value !== null) packet[6] = value;
  return packet;
}

function makeFramebufferSizeCommand(byteLength) {
  const packet = makeCommand(PROTOCOL.framebufferSize);
  packet[6] = (byteLength >>> 24) & 0xff;
  packet[7] = (byteLength >>> 16) & 0xff;
  packet[8] = (byteLength >>> 8) & 0xff;
  packet[9] = byteLength & 0xff;
  return packet;
}

function crc16(data, length) {
  let crc = 0xffff;
  for (let index = 0; index < length; index += 1) {
    crc = (crc >>> 8) ^ CRC16_TABLE[(crc ^ data[index]) & 0xff];
  }
  return crc ^ 0xffff;
}

function encodeRgbaAsBgra(rgba) {
  const bgra = new Uint8Array(rgba.length);
  for (let offset = 0; offset < rgba.length; offset += 4) {
    bgra[offset] = rgba[offset + 2];
    bgra[offset + 1] = rgba[offset + 1];
    bgra[offset + 2] = rgba[offset];
    bgra[offset + 3] = rgba[offset + 3];
  }
  return bgra;
}

function encodeRgbaAsRgb565(rgba, littleEndian = true) {
  const rgb565 = new Uint8Array((rgba.length / 4) * 2);
  for (let sourceOffset = 0, targetOffset = 0; sourceOffset < rgba.length; sourceOffset += 4, targetOffset += 2) {
    const red = rgba[sourceOffset] >>> 3;
    const green = rgba[sourceOffset + 1] >>> 2;
    const blue = rgba[sourceOffset + 2] >>> 3;
    const pixel = (red << 11) | (green << 5) | blue;
    rgb565[targetOffset + (littleEndian ? 0 : 1)] = pixel & 0xff;
    rgb565[targetOffset + (littleEndian ? 1 : 0)] = pixel >>> 8;
  }
  return rgb565;
}

function encodeFrame(rgba) {
  return pixelFormatSelect.value === "rgb565"
    ? encodeRgbaAsRgb565(rgba, byteOrderSelect.value === "little")
    : encodeRgbaAsBgra(rgba);
}

function bytesPerPixel() {
  return pixelFormatSelect.value === "rgb565" ? 2 : 4;
}

function framesEqual(left, right) {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function makeDeltaPacket(previous, current) {
  const pixels = current.length / 4;
  let recordLength = 0;
  const visitChangedRuns = (visit) => {
    let pixel = 0;
    while (pixel < pixels) {
      let offset = pixel * 4;
      if (previous[offset] === current[offset]
        && previous[offset + 1] === current[offset + 1]
        && previous[offset + 2] === current[offset + 2]
        && previous[offset + 3] === current[offset + 3]) {
        pixel += 1;
        continue;
      }

      const start = pixel++;
      while (pixel < pixels && pixel - start < 65535) {
        offset = pixel * 4;
        if (previous[offset] === current[offset]
          && previous[offset + 1] === current[offset + 1]
          && previous[offset + 2] === current[offset + 2]
          && previous[offset + 3] === current[offset + 3]) break;
        pixel += 1;
      }
      visit(start, pixel - start);
    }
  };

  visitChangedRuns((start, runLength) => {
    recordLength += runLength === 1 ? 7 : 5 + runLength * 4;
  });
  if (recordLength === 0) return null;

  const packet = new Uint8Array(COMMAND_SIZE + recordLength + 4);
  packet[0] = PROTOCOL.frameDelta;
  packet[1] = PROTOCOL.markerA;
  packet[2] = PROTOCOL.markerB;
  const protocolLength = recordLength + 2;
  packet[6] = (protocolLength >>> 24) & 0xff;
  packet[7] = (protocolLength >>> 16) & 0xff;
  packet[8] = (protocolLength >>> 8) & 0xff;
  packet[9] = protocolLength & 0xff;
  let recordOffset = COMMAND_SIZE;
  visitChangedRuns((start, runLength) => {
    packet[recordOffset++] = ((start >>> 16) & 0x7f) | (runLength === 1 ? 0x80 : 0);
    packet[recordOffset++] = (start >>> 8) & 0xff;
    packet[recordOffset++] = start & 0xff;
    if (runLength === 1) {
      const pixelOffset = start * 4;
      packet[recordOffset++] = current[pixelOffset];
      packet[recordOffset++] = current[pixelOffset + 1];
      packet[recordOffset++] = current[pixelOffset + 2];
      packet[recordOffset++] = current[pixelOffset + 3];
    } else {
      packet[recordOffset++] = (runLength >>> 8) & 0xff;
      packet[recordOffset++] = runLength & 0xff;
      for (let runPixel = start; runPixel < start + runLength; runPixel += 1) {
        const pixelOffset = runPixel * 4;
        packet[recordOffset++] = current[pixelOffset];
        packet[recordOffset++] = current[pixelOffset + 1];
        packet[recordOffset++] = current[pixelOffset + 2];
        packet[recordOffset++] = current[pixelOffset + 3];
      }
    }
  });
  const terminatorOffset = COMMAND_SIZE + recordLength;
  packet[terminatorOffset] = PROTOCOL.markerB;
  packet[terminatorOffset + 1] = PROTOCOL.markerA;
  const checksum = crc16(packet, terminatorOffset + 2);
  packet[terminatorOffset + 2] = (checksum >>> 8) & 0xff;
  packet[terminatorOffset + 3] = checksum & 0xff;
  return packet;
}

function createAckWaiter(command, timeoutMs = ACK_TIMEOUT_MS) {
  let timeoutId;
  const promise = new Promise((resolve, reject) => {
    timeoutId = window.setTimeout(() => {
      ackWaiters.delete(command);
      reject(new Error(`Timed out waiting for device acknowledgement ${command}.`));
    }, timeoutMs);
    ackWaiters.set(command, {
      resolve: () => {
        window.clearTimeout(timeoutId);
        ackWaiters.delete(command);
        resolve();
      },
      reject: (error) => {
        window.clearTimeout(timeoutId);
        ackWaiters.delete(command);
        reject(error);
      }
    });
  });
  return promise;
}

async function readSerialLoop() {
  const bytes = [];
  try {
    while (port?.readable && reader) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const byte of value) bytes.push(byte);

      for (let index = 0; index <= bytes.length - 4; index += 1) {
        if (bytes[index + 1] !== PROTOCOL.markerA
          || bytes[index + 2] !== PROTOCOL.markerB
          || bytes[index + 3] !== 1) continue;
        ackWaiters.get(bytes[index])?.resolve();
        bytes.splice(0, index + 4);
        index = -1;
      }
      if (bytes.length > 4096) bytes.splice(0, bytes.length - 16);
    }
  } catch (error) {
    if (port) setStatus(`Serial receive error: ${error.message}`, "error");
  }
}

async function writeBytes(bytes, progressLabel = "Sending frame") {
  let sent = 0;
  for (let offset = 0; offset < bytes.length; offset += SERIAL_CHUNK_SIZE) {
    if (!writer) throw new Error("Display serial connection is closed.");
    const chunk = bytes.subarray(offset, Math.min(offset + SERIAL_CHUNK_SIZE, bytes.length));
    await writer.write(chunk);
    sent += chunk.length;
    if (bytes.length > SERIAL_CHUNK_SIZE) {
      const percent = Math.round((sent / bytes.length) * 100);
      if (activeSendSource !== "auto" || autoSyncEnabled) {
        const label = activeSendSource === "auto" ? "Syncing (Auto)" : progressLabel === "Sending keyframe"
          ? "Sending Keyframe..."
          : progressLabel;
        setStatus(`${label} · ${percent}% (${Math.ceil(sent / 1024)} KB)`, activeSendSource === "auto" ? "syncing" : "sending");
      }
    }
  }
}

async function writeCommand(commandPacket, ackCommand = null, timeoutMs = ACK_TIMEOUT_MS) {
  const acknowledgement = ackCommand === null ? null : createAckWaiter(ackCommand, timeoutMs);
  await writeBytes(commandPacket, "Sending control");
  if (acknowledgement) await acknowledgement;
}

function getDimensions() {
  return resolutionSelect.value.split("x").map(Number);
}

function resizeCanvases() {
  const [width, height] = getDimensions();
  displayCanvas.width = width;
  displayCanvas.height = height;
  frameCanvas.width = width;
  frameCanvas.height = height;
  dashboardCanvas.width = width;
  dashboardCanvas.height = height;
  screenFrame.classList.toggle("is-portrait", height > width);
  previewResolution.innerHTML = `${width} × ${height} <span>${width > height ? "LANDSCAPE" : "PORTRAIT"}</span>`;
  if (port) {
    forceKeyFrame = true;
    previousFrame = null;
    targetGeneration += 1;
  }
  renderPreview();
}

function drawFallback(ctx, width, height) {
  const scale = width / 480;
  const px = (value) => Math.round(value * scale);
  ctx.fillStyle = "#101714";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#15211b";
  for (let x = 0; x < width; x += px(32)) ctx.fillRect(x, 0, 1, height);
  for (let y = 0; y < height; y += px(32)) ctx.fillRect(0, y, width, 1);

  const landscape = width > height;
  const margin = px(22);
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  const date = now.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }).toUpperCase();

  ctx.fillStyle = "#c7f36a";
  ctx.fillRect(margin, px(22), px(5), px(26));
  ctx.fillStyle = "#f1f4ec";
  ctx.font = `700 ${px(14)}px Bahnschrift, sans-serif`;
  ctx.fillText("TURMO  /  SCREEN BRIDGE", margin + px(15), px(37));
  ctx.fillStyle = "#8d9e92";
  ctx.font = `700 ${px(9)}px Bahnschrift, sans-serif`;
  ctx.fillText("PC03501A     USB DISPLAY LINK", margin, px(69));

  ctx.fillStyle = "#eef4e8";
  ctx.font = `700 ${px(landscape ? 70 : 58)}px Bahnschrift, sans-serif`;
  ctx.fillText(time, margin, px(landscape ? 157 : 145));
  ctx.fillStyle = "#a0aca2";
  ctx.font = `600 ${px(13)}px Bahnschrift, sans-serif`;
  ctx.fillText(date, margin + px(3), px(landscape ? 183 : 169));

  const cardY = px(landscape ? 210 : 198);
  const cardHeight = height - cardY - px(22);
  const cardGap = px(10);
  const cardWidth = (width - margin * 2 - cardGap) / 2;
  const items = [
    { label: "FRAME SOURCE", value: captureStream ? "SCREEN SHARE" : "LOCAL DASHBOARD", color: "#66ddc0" },
    { label: "DISPLAY LINK", value: port ? "SERIAL READY" : "WAITING", color: port ? "#c7f36a" : "#f2bd66" }
  ];
  items.forEach((item, index) => {
    const x = margin + index * (cardWidth + cardGap);
    ctx.fillStyle = "#1a2720";
    ctx.fillRect(x, cardY, cardWidth, cardHeight);
    ctx.strokeStyle = "#334239";
    ctx.strokeRect(x + 0.5, cardY + 0.5, cardWidth - 1, cardHeight - 1);
    ctx.fillStyle = item.color;
    ctx.fillRect(x + px(12), cardY + px(13), px(5), px(5));
    ctx.fillStyle = "#a0aca2";
    ctx.font = `700 ${px(8)}px Bahnschrift, sans-serif`;
    ctx.fillText(item.label, x + px(24), cardY + px(19));
    ctx.fillStyle = "#f1f4ec";
    ctx.font = `700 ${px(landscape ? 13 : 11)}px Bahnschrift, sans-serif`;
    ctx.fillText(item.value, x + px(12), cardY + px(43));
  });
}

function drawTestPattern(ctx, width, height) {
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, width, height);
  const colors = ["#ff0000", "#00ff00", "#0000ff"];
  for (let index = 0; index < colors.length; index += 1) {
    const left = Math.floor((width * index) / colors.length);
    const right = Math.floor((width * (index + 1)) / colors.length);
    ctx.fillStyle = colors[index];
    ctx.fillRect(left, 0, right - left, height);
  }
}

function drawOriented(ctx, source, width, height) {
  ctx.save();
  ctx.fillStyle = "#101714";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  switch (orientationSelect.value) {
    case "rotate-180":
      ctx.translate(width, height);
      ctx.rotate(Math.PI);
      break;
    case "flip-horizontal":
      ctx.translate(width, 0);
      ctx.scale(-1, 1);
      break;
    case "flip-vertical":
      ctx.translate(0, height);
      ctx.scale(1, -1);
      break;
    default:
      break;
  }
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  if (sourceWidth > 0 && sourceHeight > 0) {
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }
  ctx.restore();
}

function renderPreview() {
  const width = frameCanvas.width;
  const height = frameCanvas.height;
  if (testPatternActive) {
    drawTestPattern(orientationSelect.value === "normal" ? frameContext : dashboardContext, width, height);
    if (orientationSelect.value !== "normal") drawOriented(frameContext, dashboardCanvas, width, height);
  } else if (captureStream && captureVideo.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawOriented(frameContext, captureVideo, width, height);
  } else {
    drawFallback(orientationSelect.value === "normal" ? frameContext : dashboardContext, width, height);
    if (orientationSelect.value !== "normal") drawOriented(frameContext, dashboardCanvas, width, height);
  }
  displayContext.drawImage(frameCanvas, 0, 0);
}

async function sendFullFrame(frame) {
  const baudRate = currentBaudRate;
  const timeout = Math.max(ACK_TIMEOUT_MS, Math.ceil((frame.length * 10 * 1000 / baudRate) * 2.5) + 10000);
  const [width, height] = getDimensions();
  await writeBytes(makeFramebufferSizeCommand(width * height * bytesPerPixel()), "Preparing framebuffer");
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  const fullFrameAck = createAckWaiter(PROTOCOL.fullFrameAck, timeout);
  await writeBytes(frame, "Sending keyframe");
  await fullFrameAck;
  const renderAck = createAckWaiter(PROTOCOL.renderAck);
  await writeBytes(makeCommand(PROTOCOL.render, 1), "Refreshing display");
  await renderAck;
}

async function sendDeltaFrame(previous, current) {
  const packet = makeDeltaPacket(previous, current);
  if (!packet) return "unchanged";
  if (packet.length >= current.length + COMMAND_SIZE * 2) return "full";
  const renderAck = createAckWaiter(PROTOCOL.renderAck, Math.max(ACK_TIMEOUT_MS, packet.length * 10 * 1000 / currentBaudRate * 2 + 5000));
  await writeBytes(packet, "Sending changed pixels");
  await writeBytes(makeCommand(PROTOCOL.render, 1), "Refreshing display");
  await renderAck;
  latestFrameBytes = packet.length + COMMAND_SIZE;
  return "delta";
}

async function applyPendingBrightness() {
  if (pendingBrightness === null) return false;
  const value = pendingBrightness;
  pendingBrightness = null;
  await writeBytes(makeCommand(1, 1), "Resetting brightness control");
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  const brightness = makeCommand(3, 1);
  brightness[10] = value;
  await writeBytes(brightness, "Applying brightness");
  forceKeyFrame = true;
  previousFrame = null;
  return true;
}

async function sendCurrentFrame(forceFull = false, source = "manual") {
  if (!writer || sendBusy) return false;
  if (source === "auto" && !autoSyncEnabled) return false;
  sendBusy = true;
  activeSendSource = source;
  const generation = targetGeneration;
  let completed = false;
  try {
    if (pendingBrightness !== null) await applyPendingBrightness();
    renderPreview();
    const rgba = frameContext.getImageData(0, 0, frameCanvas.width, frameCanvas.height).data;
    const frame = encodeFrame(rgba);
    const startedAt = performance.now();
    if (forceFull || forceKeyFrame || !previousFrame || previousFrame.length !== frame.length) {
      await sendFullFrame(frame);
      latestFrameBytes = frame.length + COMMAND_SIZE + COMMAND_SIZE;
      forceKeyFrame = false;
    } else if (pixelFormatSelect.value === "rgb565") {
      if (framesEqual(previousFrame, frame)) {
        setStatus("Image unchanged · waiting for next frame", "connected");
        completed = true;
        return true;
      }
      await sendFullFrame(frame);
      latestFrameBytes = frame.length + COMMAND_SIZE + COMMAND_SIZE;
    } else {
      const result = await sendDeltaFrame(previousFrame, frame);
      if (result === "unchanged") {
        completed = true;
        return true;
      }
      if (result === "full") {
        await sendFullFrame(frame);
        latestFrameBytes = frame.length + COMMAND_SIZE + COMMAND_SIZE;
      }
    }
    if (generation === targetGeneration) {
      previousFrame = frame;
    } else {
      previousFrame = null;
      forceKeyFrame = true;
    }
    frameCount += 1;
    completed = true;
    const elapsed = (performance.now() - startedAt) / 1000;
    lastSent.textContent = `${Math.ceil(latestFrameBytes / 1024)} KB · ${elapsed.toFixed(1)} S`;
    const uptime = Math.max((performance.now() - frameStartedAt) / 1000, 1);
    previewRate.textContent = `${(frameCount / uptime).toFixed(1)} FPS SENT`;
    return true;
  } catch (error) {
    forceKeyFrame = true;
    previousFrame = null;
    if (source === "auto") lastFrameSentAt = performance.now();
    setStatus(error.message, "error");
    return false;
  } finally {
    sendBusy = false;
    if (completed) {
      lastFrameSentAt = performance.now();
      setStatus(autoSyncEnabled ? "Syncing (Auto)" : "Paused", autoSyncEnabled ? "syncing" : "paused");
    }
  }
}

async function disconnectDisplay() {
  const activePort = port;
  const activeWriter = writer;
  port = null;
  writer = null;
  if (activeWriter) {
    try { await activeWriter.abort(); } catch { /* A failed or unplugged port may already be aborted. */ }
    try { activeWriter.releaseLock(); } catch { /* A pending write may still be unwinding. */ }
  }
  if (reader) {
    try { await reader.cancel(); } catch { /* Port may already be closed. */ }
    try { reader.releaseLock(); } catch { /* Reader lock may already be released. */ }
    reader = null;
  }
  for (const waiter of ackWaiters.values()) waiter.reject(new Error("Display disconnected."));
  ackWaiters.clear();
  if (activePort) {
    try { await activePort.close(); } catch { /* Device may have been unplugged. */ }
  }
  connectButton.querySelector("span:last-child").textContent = "Connect TURMO Display";
  setSerialState("idle", "DISPLAY DISCONNECTED");
  setStatus("Display disconnected · dashboard preview remains active", "idle");
  previousFrame = null;
  forceKeyFrame = true;
  pendingTestPattern = false;
  pendingManualPush = false;
  testPatternButton.disabled = false;
  pushFrameButton.disabled = false;
}

function baudCandidates() {
  if (baudSelect.value === "auto") return [921600, 460800, 115200];
  return [Number(baudSelect.value)];
}

async function initializeSerialProbe(selectedPort, baudRate, frame) {
  await selectedPort.open({ baudRate, dataBits: 8, stopBits: 1, parity: "none", bufferSize: 65536 });
  port = selectedPort;
  currentBaudRate = baudRate;
  writer = port.writable.getWriter();
  reader = port.readable.getReader();
  readLoopTask = readSerialLoop();
  sendBusy = true;
  activeSendSource = "manual";
  connectButton.querySelector("span:last-child").textContent = "Disconnect TURMO Display";

  await writeBytes(makeCommand(1, 1), "Sending display reset");
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  await sendFullFrame(frame);
  sendBusy = false;
}

async function connectDisplay() {
  if (port) {
    await disconnectDisplay();
    return;
  }
  if (!("serial" in navigator)) {
    setStatus("Web Serial is unavailable. Use current Chrome or Edge on HTTPS or localhost.", "error");
    setSerialState("error", "WEB SERIAL UNAVAILABLE");
    return;
  }

  connectButton.disabled = true;
  try {
    const selectedPort = await navigator.serial.requestPort();
    activeDeviceProfileKey = deviceProfileKey(selectedPort);
    restoreDeviceSettings();
    renderPreview();
    const rgba = frameContext.getImageData(0, 0, frameCanvas.width, frameCanvas.height).data;
    const initialFrame = encodeFrame(rgba);
    let lastError = null;
    let connected = false;
    for (const baudRate of baudCandidates()) {
      setSerialState("probing", `PROBING ${baudRate} BAUD`);
      setStatus(`Checking ${baudRate} baud response`, "sending");
      try {
        await initializeSerialProbe(selectedPort, baudRate, initialFrame);
        currentBaudRate = baudRate;
        setSerialState("connected", `SERIAL CONNECTED · ${baudRate}`);
        forceKeyFrame = false;
        previousFrame = initialFrame;
        frameCount += 1;
        latestFrameBytes = initialFrame.length + COMMAND_SIZE * 2;
        lastFrameSentAt = performance.now();
        lastSent.textContent = `${Math.ceil(latestFrameBytes / 1024)} KB · INITIAL FRAME`;
        saveDeviceSettings();
        setStatus(autoSyncEnabled ? "Syncing (Auto)" : "Paused", autoSyncEnabled ? "syncing" : "paused");
        connected = true;
        break;
      } catch (error) {
        lastError = error;
        sendBusy = false;
        if (port) {
          await disconnectDisplay();
        } else {
          try { await selectedPort.close(); } catch { /* Port may not have opened. */ }
        }
      }
    }
    if (!connected) throw lastError || new Error("No supported baud rate acknowledged the probe frame.");
  } catch (error) {
    sendBusy = false;
    setSerialState("error", "CONNECTION FAILED");
    setStatus(error.name === "NotFoundError" ? "No serial port selected." : `Connection failed: ${error.message}`, "error");
    if (port) await disconnectDisplay();
  } finally {
    connectButton.disabled = false;
  }
}

async function stopSharing() {
  if (!captureStream) return;
  const stream = captureStream;
  captureStream = null;
  stream.getTracks().forEach((track) => track.stop());
  captureVideo.srcObject = null;
  shareButton.querySelector("span:last-child").textContent = "Share / Extend Screen";
  dashboardModeButton.classList.add("is-selected");
  dashboardModeButton.setAttribute("aria-pressed", "true");
  sharedModeButton.classList.remove("is-selected");
  sharedModeButton.setAttribute("aria-pressed", "false");
  setStatus("Screen share stopped · local dashboard is active", port ? "connected" : "idle");
  renderPreview();
}

async function startSharing() {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus("Screen capture is unavailable. Use Chrome or Edge on HTTPS or localhost.", "error");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 10, max: 15 } },
      audio: false
    });
    captureStream = stream;
    testPatternActive = false;
    captureVideo.srcObject = stream;
    await captureVideo.play();
    stream.getVideoTracks()[0].addEventListener("ended", () => {
      if (captureStream === stream) stopSharing();
    }, { once: true });
    shareButton.querySelector("span:last-child").textContent = "Stop Screen Sharing";
    dashboardModeButton.classList.remove("is-selected");
    dashboardModeButton.setAttribute("aria-pressed", "false");
    sharedModeButton.classList.add("is-selected");
    sharedModeButton.setAttribute("aria-pressed", "true");
    setStatus("Screen share active · source is scaled to panel size", port ? "connected" : "idle");
    renderPreview();
  } catch (error) {
    setStatus(error.name === "NotAllowedError" ? "Screen sharing was cancelled." : `Screen capture failed: ${error.message}`, "error");
  }
}

async function sendTestPattern() {
  if (!port || !writer) {
    setStatus("Connect the TURMO serial port before sending the test pattern.", "error");
    return;
  }
  testPatternActive = true;
  forceKeyFrame = true;
  previousFrame = null;
  testPatternButton.disabled = true;
  pendingTestPattern = true;
  setStatus(`Sending uncompressed ${pixelFormatSelect.value.toUpperCase()} red / green / blue pattern`, "sending");
  if (!sendBusy) {
    pendingTestPattern = false;
    await sendCurrentFrame(true, "manual");
    testPatternButton.disabled = false;
  }
}

async function pushFrameNow() {
  if (!port || !writer) {
    setStatus("Connect the TURMO serial port before pushing a frame.", "error");
    return;
  }
  pushFrameButton.disabled = true;
  pendingManualPush = true;
  if (!sendBusy) {
    pendingManualPush = false;
    await sendCurrentFrame(true, "manual");
    pushFrameButton.disabled = false;
  } else {
    setStatus("Push queued · waiting for the current frame to finish", "sending");
  }
}

connectButton.addEventListener("click", connectDisplay);
shareButton.addEventListener("click", () => captureStream ? stopSharing() : startSharing());
dashboardModeButton.addEventListener("click", () => {
  testPatternActive = false;
  stopSharing();
  renderPreview();
});
sharedModeButton.addEventListener("click", () => {
  if (!captureStream) startSharing();
});
resolutionSelect.addEventListener("change", () => {
  resizeCanvases();
  setStatus(port ? "Panel size changed · a new full frame will be sent" : "Panel size changed · local preview updated", port ? "connected" : "idle");
});
orientationSelect.addEventListener("change", () => {
  renderPreview();
  if (port) {
    forceKeyFrame = true;
    previousFrame = null;
    targetGeneration += 1;
  }
});
pixelFormatSelect.addEventListener("change", () => {
  byteOrderField.hidden = pixelFormatSelect.value !== "rgb565";
  forceKeyFrame = true;
  previousFrame = null;
  targetGeneration += 1;
  renderPreview();
  setStatus(`${pixelFormatSelect.value.toUpperCase()} selected · next frame will reset framebuffer size`, port ? "connected" : "idle");
});
byteOrderSelect.addEventListener("change", () => {
  forceKeyFrame = true;
  previousFrame = null;
  targetGeneration += 1;
  setStatus(`RGB565 ${byteOrderSelect.value}-endian selected · next frame will be uncompressed`, port ? "connected" : "idle");
});
testPatternButton.addEventListener("click", sendTestPattern);
pushFrameButton.addEventListener("click", pushFrameNow);
autoSyncToggle.addEventListener("change", () => {
  autoSyncEnabled = autoSyncToggle.checked;
  if (autoSyncEnabled) {
    lastFrameSentAt = performance.now() - getTargetIntervalMs();
    setStatus(port ? "Syncing (Auto)" : "Auto-Sync armed · connect the display", "syncing");
  } else {
    setStatus(sendBusy ? "Paused after current frame completes" : port ? "Paused" : "Idle", sendBusy || port ? "paused" : "idle");
  }
});
targetFpsSlider.addEventListener("input", () => {
  targetFpsOutput.value = targetFpsSlider.value;
  targetFpsOutput.textContent = targetFpsSlider.value;
});
brightnessSlider.addEventListener("input", () => {
  brightnessOutput.value = brightnessSlider.value;
  pendingBrightness = Number(brightnessSlider.value);
  if (autoSyncEnabled) {
    setStatus("Brightness queued for the next auto frame", "syncing");
  } else {
    setStatus(port ? "Paused · brightness queued until the next manual push" : "Idle", port ? "paused" : "idle");
  }
});

for (const control of [
  resolutionSelect,
  baudSelect,
  orientationSelect,
  pixelFormatSelect,
  byteOrderSelect,
  brightnessSlider,
  targetFpsSlider
]) {
  control.addEventListener("change", saveDeviceSettings);
}

if ("serial" in navigator) {
  navigator.serial.addEventListener("disconnect", (event) => {
    if (event.target === port) disconnectDisplay();
  });
} else {
  connectButton.title = "Web Serial requires Chrome or Edge on HTTPS or localhost.";
}

resizeCanvases();
setStatus("Idle", "idle");
setInterval(() => {
  renderPreview();
  if (pendingManualPush && port && !sendBusy) {
    pendingManualPush = false;
    sendCurrentFrame(true, "manual").finally(() => {
      pushFrameButton.disabled = false;
    });
  } else if (pendingTestPattern && port && !sendBusy) {
    pendingTestPattern = false;
    sendCurrentFrame(true, "manual").finally(() => {
      testPatternButton.disabled = false;
    });
  }
  const now = performance.now();
  if (autoSyncEnabled && port && !sendBusy && now - lastFrameSentAt >= getTargetIntervalMs()) {
    sendCurrentFrame(false, "auto");
  }
}, 25);

window.addEventListener("beforeunload", () => {
  captureStream?.getTracks().forEach((track) => track.stop());
  reader?.cancel();
  writer?.releaseLock();
});

window.TURMOProtocol = Object.freeze({
  crc16,
  makeCommand,
  makeFramebufferSizeCommand,
  makeDeltaPacket,
  encodeRgbaAsBgra,
  encodeRgbaAsRgb565
});