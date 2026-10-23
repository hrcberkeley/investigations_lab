import * as ort from "./ort.all.min.mjs";

const MODEL_CONFIGS = {
  yolo26n: {
    key: "yolo26n",
    label: "YOLO26n (Fastest)",
    family: "yolo-seg",
    sources: [
      "https://huggingface.co/AXERA-TECH/yolo26-seg/resolve/main/yolo26n-seg_640x640.onnx",
      "./yolo26n-seg.onnx",
    ],
    defaultSize: 640,
  },
  yolo26s: {
    key: "yolo26s",
    label: "YOLO26s (Small)",
    family: "yolo-seg",
    sources: [
      "https://huggingface.co/AXERA-TECH/yolo26-seg/resolve/main/yolo26s-seg_640x640.onnx",
      "./yolo26s-seg.onnx",
    ],
    defaultSize: 640,
  },
  yolo11n: {
    key: "yolo11n",
    label: "YOLO11n (Legacy Fast)",
    family: "yolo-seg",
    path: "./yolo11n-seg.onnx",
    defaultSize: 640,
  },
  yolo11s: {
    key: "yolo11s",
    label: "YOLO11s (Legacy Accurate)",
    family: "yolo-seg",
    path: "./yolo11s-seg.onnx",
    defaultSize: 640,
  },
  rfdetrNano: {
    key: "rfdetrNano",
    label: "RF-DETR Seg Nano (Smallest)",
    family: "rfdetr-seg",
    sources: [
      "https://huggingface.co/PierreMarieCurie/rf-detr-onnx/resolve/main/rf-detr-seg-nano.onnx",
      "./rf-detr-seg-nano.onnx",
    ],
    defaultSize: 640,
  },
  rfdetrSmall: {
    key: "rfdetrSmall",
    label: "RF-DETR Seg Small",
    family: "rfdetr-seg",
    sources: [
      "https://huggingface.co/PierreMarieCurie/rf-detr-onnx/resolve/main/rf-detr-seg-small.onnx",
      "./rf-detr-seg-small.onnx",
    ],
    defaultSize: 640,
  },
};

const explanations = {
  sensitivity: {
    title: "Confidence Threshold",
    text: "Higher values reduce false positives but can miss people. Lower values catch more people with more noise.",
  },
  iou: {
    title: "IOU Threshold",
    text: "Controls how strongly overlapping detections are merged by non-maximum suppression.",
  },
  mask: {
    title: "Mask Threshold",
    text: "Higher values create tighter masks. Lower values create larger masks.",
  },
  frameSkip: {
    title: "Frame Skip",
    text: "Skips model inference on intermediate frames for speed and reuses the last mask.",
  },
};

const videoUpload = document.getElementById("videoUpload");
const sourceVideo = document.getElementById("sourceVideo");
const outputCanvas = document.getElementById("outputCanvas");
const processBtn = document.getElementById("processBtn");
const statusEl = document.getElementById("status");
const fileNameEl = document.getElementById("fileName");

const confidenceSlider = document.getElementById("sensitivity");
const confidenceValue = document.getElementById("sensitivityValue");
const iouSlider = document.getElementById("iouThreshold");
const iouValue = document.getElementById("iouValue");
const maskSlider = document.getElementById("maskThreshold");
const maskValue = document.getElementById("maskValue");
const frameSkipSlider = document.getElementById("frameSkip");
const frameSkipValue = document.getElementById("frameSkipValue");

const modelSelect = document.getElementById("modelSelect");
const bnwToggle = document.getElementById("bnwToggle");
const muteToggle = document.getElementById("muteToggle");

const infoModal = document.getElementById("infoModal");
const disclaimerModal = document.getElementById("disclaimerModal");
const aboutModal = document.getElementById("aboutModal");
const aboutBtn = document.getElementById("aboutBtn");
const acceptDisclaimer = document.getElementById("acceptDisclaimer");
const modalTitle = document.getElementById("modalTitle");
const modalText = document.getElementById("modalText");
const closeModalButtons = document.querySelectorAll(".close-modal");
const infoButtons = document.querySelectorAll(".info-btn");

const outputCtx = outputCanvas.getContext("2d");

let session = null;
let currentModelConfig = MODEL_CONFIGS[modelSelect.value] || MODEL_CONFIGS.yolo26n;
let isProcessing = false;
let frameCounter = 0;
let confidenceThreshold = Number(confidenceSlider.value);
let iouThreshold = Number(iouSlider.value);
let maskThreshold = Number(maskSlider.value);
let frameSkip = Number(frameSkipSlider.value);
let isBnW = false;
let isMuted = false;

let maskOverlayCanvas = null;
let maskOverlayCtx = null;
let tinyMaskCanvas = null;
let tinyMaskCtx = null;
let tinyMaskImageData = null;
let resolvedInputSize = null;

function showModal(modal) {
  modal.classList.remove("hidden");
}

function hideModal(modal) {
  modal.classList.add("hidden");
}

function setStatus(msg) {
  statusEl.textContent = msg;
}

function readDimensions(meta) {
  if (!meta) return null;
  if (Array.isArray(meta.dimensions)) return meta.dimensions;
  if (Array.isArray(meta.dims)) return meta.dims;
  if (Array.isArray(meta.shape)) return meta.shape;
  return null;
}

function getInputSizeFromSession(loadedSession, fallbackSize) {
  const inputName = loadedSession.inputNames[0];
  const metadataObj = loadedSession.inputMetadata || {};
  const metaByName = metadataObj[inputName];
  const firstMeta = Object.values(metadataObj)[0];
  const meta = metaByName || firstMeta;
  const dims = readDimensions(meta);
  if (Array.isArray(dims) && dims.length >= 4) {
    const h = Number(dims[2]);
    const w = Number(dims[3]);
    if (Number.isFinite(h) && Number.isFinite(w) && h > 0 && w > 0) {
      return { width: w, height: h };
    }
  }
  return { width: fallbackSize, height: fallbackSize };
}

async function loadModel(modelKey = modelSelect.value) {
  const modelConfig = MODEL_CONFIGS[modelKey];
  if (!modelConfig) {
    setStatus(`Unknown model: ${modelKey}`);
    return;
  }

  currentModelConfig = modelConfig;
  setStatus(`Loading ${modelConfig.label}...`);
  processBtn.disabled = true;

  try {
    const wasmPath = new URL("./wasm/", window.location.href).toString();
    ort.env.wasm.wasmPaths = wasmPath;

    const candidatePaths = modelConfig.sources || [modelConfig.path];
    if (!candidatePaths || candidatePaths.length === 0) {
      throw new Error(`No model source configured for ${modelConfig.key}`);
    }

    session = null;
    let lastError = null;
    for (const candidatePath of candidatePaths) {
      try {
        session = await ort.InferenceSession.create(candidatePath, {
          executionProviders: ["webgpu", "webgl", "wasm"],
        });
        break;
      } catch (err) {
        lastError = err;
      }
    }

    if (!session) {
      throw lastError || new Error("Model loading failed for all configured sources.");
    }
    resolvedInputSize = getInputSizeFromSession(session, modelConfig.defaultSize);

    if (!sourceVideo.src) {
      setStatus("Model loaded. Upload a video.");
    } else {
      setStatus("Model loaded. Ready to process.");
      processBtn.disabled = false;
    }
  } catch (err) {
    console.error("Model load error", err);
    const localPath = (modelConfig.sources || [modelConfig.path]).find((src) => src.startsWith("./"));
    if (localPath) {
      setStatus(
        `Error loading model: ${err.message}. Remote fetch may be blocked; place ${localPath.replace("./", "")} in the app folder as fallback.`,
      );
      return;
    }
    setStatus(`Error loading model: ${err.message}`);
  }
}

function initMaskBuffers(width, height) {
  maskOverlayCanvas = document.createElement("canvas");
  maskOverlayCanvas.width = width;
  maskOverlayCanvas.height = height;
  maskOverlayCtx = maskOverlayCanvas.getContext("2d");
}

function renderVideoFrame() {
  outputCtx.filter = isBnW ? "grayscale(100%)" : "none";
  outputCtx.drawImage(sourceVideo, 0, 0, outputCanvas.width, outputCanvas.height);
  outputCtx.filter = "none";
}

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function softmax(values) {
  let maxValue = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > maxValue) maxValue = values[i];
  }
  let sum = 0;
  const exps = new Float32Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    const v = Math.exp(values[i] - maxValue);
    exps[i] = v;
    sum += v;
  }
  if (sum <= 0) return exps;
  for (let i = 0; i < exps.length; i += 1) {
    exps[i] /= sum;
  }
  return exps;
}

function computeIoU(boxA, boxB) {
  const x1 = Math.max(boxA[0], boxB[0]);
  const y1 = Math.max(boxA[1], boxB[1]);
  const x2 = Math.min(boxA[0] + boxA[2], boxB[0] + boxB[2]);
  const y2 = Math.min(boxA[1] + boxA[3], boxB[1] + boxB[3]);

  if (x2 <= x1 || y2 <= y1) return 0;

  const intersection = (x2 - x1) * (y2 - y1);
  const areaA = boxA[2] * boxA[3];
  const areaB = boxB[2] * boxB[3];
  return intersection / (areaA + areaB - intersection);
}

function nms(boxes, scores) {
  const sorted = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const keep = [];

  while (sorted.length > 0) {
    const candidate = sorted.shift();
    keep.push(candidate);
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const overlap = computeIoU(boxes[candidate], boxes[sorted[i]]);
      if (overlap > iouThreshold) {
        sorted.splice(i, 1);
      }
    }
  }

  return keep;
}

function createInputTensor(video, width, height, family) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, width, height);
  const rgba = ctx.getImageData(0, 0, width, height).data;

  const hw = width * height;
  const chw = new Float32Array(3 * hw);

  if (family === "rfdetr-seg") {
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    for (let i = 0; i < hw; i += 1) {
      const r = rgba[i * 4] / 255;
      const g = rgba[i * 4 + 1] / 255;
      const b = rgba[i * 4 + 2] / 255;
      chw[i] = (r - mean[0]) / std[0];
      chw[hw + i] = (g - mean[1]) / std[1];
      chw[2 * hw + i] = (b - mean[2]) / std[2];
    }
  } else {
    for (let i = 0; i < hw; i += 1) {
      chw[i] = rgba[i * 4] / 255;
      chw[hw + i] = rgba[i * 4 + 1] / 255;
      chw[2 * hw + i] = rgba[i * 4 + 2] / 255;
    }
  }

  return new ort.Tensor("float32", chw, [1, 3, height, width]);
}

function decodeYoloSegmentation(outputs) {
  const outputTensors = session.outputNames.map((name) => outputs[name]);
  const inputSize = resolvedInputSize || getInputSizeFromSession(session, currentModelConfig.defaultSize);

  const protoCandidate = outputTensors.find(
    (t) =>
      t.dims.length === 4 &&
      t.dims[0] === 1 &&
      t.dims[1] > 8 &&
      t.dims[1] <= 128 &&
      t.dims[2] === t.dims[3] &&
      t.dims[2] >= 96,
  );

  const nhwcHeads = outputTensors.filter(
    (t) =>
      t.dims.length === 4 &&
      t.dims[0] === 1 &&
      t.dims[1] === t.dims[2] &&
      t.dims[1] >= 10 &&
      t.dims[1] <= 160 &&
      t.dims[3] > 1,
  );

  // YOLO26 exported heads: per-scale NHWC tensors for boxes/classes/mask coeffs, plus one proto tensor.
  if (protoCandidate && nhwcHeads.length >= 6) {
    const proto = protoCandidate.data;
    const protoChannels = protoCandidate.dims[1];
    const protoHeight = protoCandidate.dims[2];
    const protoWidth = protoCandidate.dims[3];

    const headsBySize = new Map();
    for (const tensor of nhwcHeads) {
      if (tensor === protoCandidate) continue;
      const size = tensor.dims[1];
      const list = headsBySize.get(size) || [];
      list.push(tensor);
      headsBySize.set(size, list);
    }

    const scales = [];
    for (const [size, tensors] of headsBySize.entries()) {
      const boxTensor = tensors.find((t) => t.dims[3] === 4);
      const maskTensor = tensors.find((t) => t.dims[3] === protoChannels);
      const classTensor = tensors.find((t) => t !== boxTensor && t !== maskTensor);
      if (boxTensor && maskTensor && classTensor) {
        scales.push({
          size,
          strideX: inputSize.width / size,
          strideY: inputSize.height / size,
          box: boxTensor,
          cls: classTensor,
          coeff: maskTensor,
          classCount: classTensor.dims[3],
        });
      }
    }

    if (scales.length > 0) {
      const boxes = [];
      const scores = [];
      const maskCoeffs = [];

      for (const scale of scales) {
        const { size, strideX, strideY, box, cls, coeff, classCount } = scale;
        const boxData = box.data;
        const clsData = cls.data;
        const coeffData = coeff.data;

        for (let y = 0; y < size; y += 1) {
          for (let x = 0; x < size; x += 1) {
            const base = (y * size + x) * 4;
            const l = boxData[base + 0];
            const t = boxData[base + 1];
            const r = boxData[base + 2];
            const b = boxData[base + 3];

            let bestClass = -1;
            let bestScore = -1;
            const clsBase = (y * size + x) * classCount;
            for (let c = 0; c < classCount; c += 1) {
              const raw = clsData[clsBase + c];
              const score = raw >= 0 && raw <= 1 ? raw : sigmoid(raw);
              if (score > bestScore) {
                bestScore = score;
                bestClass = c;
              }
            }

            if (bestClass !== 0 || bestScore < confidenceThreshold) continue;

            const cx = (x + 0.5) * strideX;
            const cy = (y + 0.5) * strideY;
            const x1 = Math.max(0, cx - l * strideX);
            const y1 = Math.max(0, cy - t * strideY);
            const x2 = Math.min(inputSize.width, cx + r * strideX);
            const y2 = Math.min(inputSize.height, cy + b * strideY);
            const w = x2 - x1;
            const h = y2 - y1;

            if (w <= 1 || h <= 1) continue;

            boxes.push([x1, y1, w, h]);
            scores.push(bestScore);

            const coeffBase = (y * size + x) * protoChannels;
            const coeffs = new Float32Array(protoChannels);
            for (let m = 0; m < protoChannels; m += 1) {
              coeffs[m] = coeffData[coeffBase + m];
            }
            maskCoeffs.push(coeffs);
          }
        }
      }

      return {
        boxes,
        scores,
        maskCoeffs,
        proto,
        protoChannels,
        protoHeight,
        protoWidth,
      };
    }
  }

  const rank3 = outputTensors.filter((t) => t.dims.length === 3);
  const rank4 = outputTensors.filter((t) => t.dims.length === 4);
  const rank2 = outputTensors.filter((t) => t.dims.length === 2);
  if (rank3.length === 0) {
    throw new Error("Unexpected YOLO segmentation output tensor structure (no rank-3 heads).");
  }

  const parseRank3 = (tensor) => {
    const d1 = tensor.dims[1];
    const d2 = tensor.dims[2];
    const channelAxis = d1 <= d2 ? 1 : 2;
    const channels = channelAxis === 1 ? d1 : d2;
    const proposals = channelAxis === 1 ? d2 : d1;
    return {
      tensor,
      channels,
      proposals,
      getValue: (channel, proposal) =>
        channelAxis === 1
          ? tensor.data[channel * proposals + proposal]
          : tensor.data[proposal * channels + channel],
    };
  };

  const parsed = rank3.map(parseRank3);
  let proposals = null;
  let getBox = null;
  let getClass = null;
  let getCoeff = null;
  let classCount = null;
  let maskDim = null;

  const combined = parsed.find((p) => p.channels > 40);
  if (combined) {
    proposals = combined.proposals;
    const inferredMaskDims = [32, 64];
    maskDim = inferredMaskDims.find((m) => combined.channels - 4 - m > 0) || 32;
    classCount = combined.channels - 4 - maskDim;
    if (classCount <= 0) {
      throw new Error("Invalid YOLO combined output dimensions.");
    }
    getBox = (proposal, idx) => combined.getValue(idx, proposal);
    getClass = (proposal, cls) => combined.getValue(4 + cls, proposal);
    getCoeff = (proposal, idx) => combined.getValue(4 + classCount + idx, proposal);
  } else {
    const boxHead = parsed.find((p) => p.channels === 4) || parsed.find((p) => p.channels <= 6);
    const coeffHead = parsed.find((p) => p.channels === 32 || p.channels === 64);
    const classHead = parsed.find((p) => p !== boxHead && p !== coeffHead);

    if (!boxHead || !coeffHead || !classHead) {
      throw new Error("Unsupported YOLO split-head output format.");
    }
    if (
      boxHead.proposals !== coeffHead.proposals ||
      boxHead.proposals !== classHead.proposals
    ) {
      throw new Error("YOLO split-head outputs have mismatched proposal counts.");
    }

    proposals = boxHead.proposals;
    maskDim = coeffHead.channels;
    classCount = classHead.channels;
    getBox = (proposal, idx) => boxHead.getValue(idx, proposal);
    getClass = (proposal, cls) => classHead.getValue(cls, proposal);
    getCoeff = (proposal, idx) => coeffHead.getValue(idx, proposal);
  }

  function buildProtoTensor(expectedMaskDim) {
    const proto4d = rank4.find((t) => t.dims[1] === expectedMaskDim);
    if (proto4d) {
      return {
        proto: proto4d.data,
        protoChannels: proto4d.dims[1],
        protoHeight: proto4d.dims[2],
        protoWidth: proto4d.dims[3],
      };
    }

    const flatCandidates = [...rank3, ...rank2];
    for (const tensor of flatCandidates) {
      const dims = tensor.dims;
      let channels = null;
      let hw = null;

      if (dims.length === 3) {
        if (dims[1] === expectedMaskDim) {
          channels = dims[1];
          hw = dims[2];
        } else if (dims[2] === expectedMaskDim) {
          channels = dims[2];
          hw = dims[1];
        }
      } else if (dims.length === 2) {
        if (dims[0] === expectedMaskDim) {
          channels = dims[0];
          hw = dims[1];
        } else if (dims[1] === expectedMaskDim) {
          channels = dims[1];
          hw = dims[0];
        }
      }

      if (!channels || !hw) continue;
      const side = Math.round(Math.sqrt(hw));
      if (side * side !== hw) continue;

      const arranged = new Float32Array(channels * hw);
      if (dims.length === 3 && dims[1] === channels) {
        arranged.set(tensor.data);
      } else if (dims.length === 3 && dims[2] === channels) {
        for (let i = 0; i < hw; i += 1) {
          for (let c = 0; c < channels; c += 1) {
            arranged[c * hw + i] = tensor.data[i * channels + c];
          }
        }
      } else if (dims.length === 2 && dims[0] === channels) {
        arranged.set(tensor.data);
      } else {
        for (let i = 0; i < hw; i += 1) {
          for (let c = 0; c < channels; c += 1) {
            arranged[c * hw + i] = tensor.data[i * channels + c];
          }
        }
      }

      return {
        proto: arranged,
        protoChannels: channels,
        protoHeight: side,
        protoWidth: side,
      };
    }

    const debugShapes = outputTensors.map((t) => `[${t.dims.join(",")}]`).join(" ");
    throw new Error(`Could not locate YOLO prototype tensor. Outputs: ${debugShapes}`);
  }

  const protoInfo = buildProtoTensor(maskDim);

  const boxes = [];
  const scores = [];
  const maskCoeffs = [];

  for (let i = 0; i < proposals; i += 1) {
    let bestClass = -1;
    let bestScore = -1;

    for (let c = 0; c < classCount; c += 1) {
      const raw = getClass(i, c);
      const score = raw >= 0 && raw <= 1 ? raw : sigmoid(raw);
      if (score > bestScore) {
        bestScore = score;
        bestClass = c;
      }
    }

    if (bestClass === 0 && bestScore >= confidenceThreshold) {
      const cx = getBox(i, 0);
      const cy = getBox(i, 1);
      const w = getBox(i, 2);
      const h = getBox(i, 3);

      boxes.push([cx - w / 2, cy - h / 2, w, h]);
      scores.push(bestScore);

      const coeffs = new Float32Array(maskDim);
      for (let m = 0; m < maskDim; m += 1) {
        coeffs[m] = getCoeff(i, m);
      }
      maskCoeffs.push(coeffs);
    }
  }

  return {
    boxes,
    scores,
    maskCoeffs,
    proto: protoInfo.proto,
    protoChannels: protoInfo.protoChannels,
    protoHeight: protoInfo.protoHeight,
    protoWidth: protoInfo.protoWidth,
  };
}

function pickRfDetrOutputs(outputs) {
  const tensors = session.outputNames.map((name) => outputs[name]);

  let logitsTensor = null;
  let boxesTensor = null;
  let masksTensor = null;

  for (const tensor of tensors) {
    if (tensor.dims.length === 4) {
      masksTensor = tensor;
    } else if (tensor.dims.length === 3) {
      const last = tensor.dims[2];
      if (last === 4) {
        boxesTensor = tensor;
      } else {
        logitsTensor = tensor;
      }
    }
  }

  if (!logitsTensor || !boxesTensor || !masksTensor) {
    throw new Error("Unexpected RF-DETR output tensor structure.");
  }

  return { logitsTensor, boxesTensor, masksTensor };
}

function decodeRfDetrSegmentation(outputs) {
  const { logitsTensor, boxesTensor, masksTensor } = pickRfDetrOutputs(outputs);

  const logits = logitsTensor.data;
  const boxes = boxesTensor.data;

  const numQueries = logitsTensor.dims[1];
  const numClasses = logitsTensor.dims[2];
  const hasNoObjectClass = numClasses > 1;
  const personCandidates = [0, 1];

  const filteredBoxes = [];
  const filteredScores = [];
  const queryIndices = [];
  const effectiveThreshold = Math.min(confidenceThreshold, 0.25);

  for (let q = 0; q < numQueries; q += 1) {
    const classLogits = new Float32Array(numClasses);
    for (let c = 0; c < numClasses; c += 1) {
      classLogits[c] = logits[q * numClasses + c];
    }
    const probs = softmax(classLogits);

    const classUpperBound = hasNoObjectClass ? numClasses - 1 : numClasses;
    let personScore = -1;
    for (const idx of personCandidates) {
      if (idx >= 0 && idx < classUpperBound) {
        personScore = Math.max(personScore, probs[idx]);
      }
    }

    if (personScore >= effectiveThreshold) {
      const cx = boxes[q * 4 + 0];
      const cy = boxes[q * 4 + 1];
      const w = boxes[q * 4 + 2];
      const h = boxes[q * 4 + 3];
      filteredBoxes.push([cx - w / 2, cy - h / 2, w, h]);
      filteredScores.push(personScore);
      queryIndices.push(q);
    }
  }

  return {
    boxes: filteredBoxes,
    scores: filteredScores,
    queryIndices,
    masksTensor,
  };
}

function drawYoloMasks(decoded, keepIndices) {
  if (!maskOverlayCtx) return;

  const { maskCoeffs, proto, protoChannels, protoHeight, protoWidth } = decoded;

  if (!tinyMaskCanvas || tinyMaskCanvas.width !== protoWidth || tinyMaskCanvas.height !== protoHeight) {
    tinyMaskCanvas = document.createElement("canvas");
    tinyMaskCanvas.width = protoWidth;
    tinyMaskCanvas.height = protoHeight;
    tinyMaskCtx = tinyMaskCanvas.getContext("2d");
    tinyMaskImageData = tinyMaskCtx.createImageData(protoWidth, protoHeight);
  }

  const pixels = tinyMaskImageData.data;
  const hw = protoWidth * protoHeight;

  maskOverlayCtx.clearRect(0, 0, maskOverlayCanvas.width, maskOverlayCanvas.height);
  maskOverlayCtx.fillStyle = "black";

  for (const idx of keepIndices) {
    const coeff = maskCoeffs[idx];

    for (let i = 0; i < hw; i += 1) {
      let sum = 0;
      for (let c = 0; c < protoChannels; c += 1) {
        sum += proto[c * hw + i] * coeff[c];
      }

      if (sigmoid(sum) > maskThreshold) {
        const p = i * 4;
        pixels[p] = 0;
        pixels[p + 1] = 0;
        pixels[p + 2] = 0;
        pixels[p + 3] = 255;
      } else {
        pixels[i * 4 + 3] = 0;
      }
    }

    tinyMaskCtx.putImageData(tinyMaskImageData, 0, 0);
    maskOverlayCtx.drawImage(
      tinyMaskCanvas,
      0,
      0,
      maskOverlayCanvas.width,
      maskOverlayCanvas.height,
    );
  }
}

function getMaskSlice(masksTensor, queryIndex) {
  const dims = masksTensor.dims;
  const data = masksTensor.data;

  if (dims.length !== 4) {
    throw new Error("RF-DETR masks tensor must be rank 4.");
  }

  if (dims[0] === 1) {
    const queries = dims[1];
    const h = dims[2];
    const w = dims[3];
    if (queryIndex >= queries) return null;

    const hw = h * w;
    const start = queryIndex * hw;
    return { data, start, h, w };
  }

  const queries = dims[0];
  const channels = dims[1];
  const h = dims[2];
  const w = dims[3];
  if (queryIndex >= queries || channels < 1) return null;

  const hw = h * w;
  const start = queryIndex * channels * hw;
  return { data, start, h, w };
}

function drawRfDetrMasks(decoded, keepIndices) {
  if (!maskOverlayCtx) return;

  maskOverlayCtx.clearRect(0, 0, maskOverlayCanvas.width, maskOverlayCanvas.height);

  for (const keepIdx of keepIndices) {
    const queryIndex = decoded.queryIndices[keepIdx];
    const maskSlice = getMaskSlice(decoded.masksTensor, queryIndex);
    if (!maskSlice) continue;

    const { data, start, h, w } = maskSlice;

    if (!tinyMaskCanvas || tinyMaskCanvas.width !== w || tinyMaskCanvas.height !== h) {
      tinyMaskCanvas = document.createElement("canvas");
      tinyMaskCanvas.width = w;
      tinyMaskCanvas.height = h;
      tinyMaskCtx = tinyMaskCanvas.getContext("2d");
      tinyMaskImageData = tinyMaskCtx.createImageData(w, h);
    }

    const pixels = tinyMaskImageData.data;
    const hw = w * h;
    let minVal = Infinity;
    let maxVal = -Infinity;
    for (let i = 0; i < hw; i += 1) {
      const v = data[start + i];
      if (v < minVal) minVal = v;
      if (v > maxVal) maxVal = v;
    }
    const alreadyProbabilities = minVal >= 0 && maxVal <= 1;

    for (let i = 0; i < hw; i += 1) {
      const raw = data[start + i];
      const score = alreadyProbabilities ? raw : sigmoid(raw);
      if (score > maskThreshold) {
        const p = i * 4;
        pixels[p] = 0;
        pixels[p + 1] = 0;
        pixels[p + 2] = 0;
        pixels[p + 3] = 255;
      } else {
        pixels[i * 4 + 3] = 0;
      }
    }

    tinyMaskCtx.putImageData(tinyMaskImageData, 0, 0);
    maskOverlayCtx.drawImage(tinyMaskCanvas, 0, 0, maskOverlayCanvas.width, maskOverlayCanvas.height);
  }
}

async function processFrameWithModel() {
  if (!session) return;

  const { width: inputWidth, height: inputHeight } =
    resolvedInputSize || getInputSizeFromSession(session, currentModelConfig.defaultSize);

  const inputTensor = createInputTensor(sourceVideo, inputWidth, inputHeight, currentModelConfig.family);
  const feeds = { [session.inputNames[0]]: inputTensor };

  const outputs = await session.run(feeds);

  renderVideoFrame();

  if (currentModelConfig.family === "yolo-seg") {
    const decoded = decodeYoloSegmentation(outputs);
    if (decoded.boxes.length > 0) {
      const keep = nms(decoded.boxes, decoded.scores);
      drawYoloMasks(decoded, keep);
      outputCtx.drawImage(maskOverlayCanvas, 0, 0);
    }
  } else {
    const decoded = decodeRfDetrSegmentation(outputs);
    if (decoded.boxes.length > 0) {
      const keep = nms(decoded.boxes, decoded.scores);
      drawRfDetrMasks(decoded, keep);
      outputCtx.drawImage(maskOverlayCanvas, 0, 0);
    }
  }

  inputTensor.dispose();
}

function drawFrameUsingPreviousMask() {
  renderVideoFrame();
  if (maskOverlayCanvas) {
    outputCtx.drawImage(maskOverlayCanvas, 0, 0);
  }
}

async function processingLoop() {
  if (!isProcessing) return;

  if (sourceVideo.paused || sourceVideo.ended) {
    requestAnimationFrame(processingLoop);
    return;
  }

  try {
    if (frameCounter % (frameSkip + 1) === 0) {
      await processFrameWithModel();
    } else {
      drawFrameUsingPreviousMask();
    }
  } catch (err) {
    console.error("Processing error", err);
    setStatus(`Error: ${err.message}`);
    isProcessing = false;
    processBtn.textContent = "Start Processing";
    return;
  }

  frameCounter += 1;
  requestAnimationFrame(processingLoop);
}

async function startProcessing() {
  if (!session || !sourceVideo.src) return;

  isProcessing = true;
  processBtn.textContent = "Stop Processing";
  setStatus("Processing...");

  sourceVideo.muted = isMuted;
  sourceVideo.volume = isMuted ? 0 : 1;

  await sourceVideo.play();
  requestAnimationFrame(processingLoop);
}

function stopProcessing() {
  sourceVideo.pause();
  isProcessing = false;
  processBtn.textContent = "Start Processing";
  setStatus("Processing stopped.");
}

function wireModalEvents() {
  infoButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.id === "aboutBtn") return;
      const key = btn.getAttribute("data-info");
      const info = explanations[key];
      if (!info) return;
      modalTitle.textContent = info.title;
      modalText.textContent = info.text;
      showModal(infoModal);
    });
  });

  aboutBtn.addEventListener("click", () => {
    showModal(aboutModal);
  });

  closeModalButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const modalId = btn.getAttribute("data-modal");
      const modal = document.getElementById(modalId);
      if (modal) hideModal(modal);
    });
  });

  acceptDisclaimer.addEventListener("click", () => {
    hideModal(disclaimerModal);
  });

  window.addEventListener("click", (event) => {
    if (event.target.classList.contains("modal")) {
      hideModal(event.target);
    }
  });

  window.addEventListener("load", () => {
    showModal(disclaimerModal);
  });
}

function wireControlEvents() {
  confidenceSlider.addEventListener("input", () => {
    confidenceThreshold = Number(confidenceSlider.value);
    confidenceValue.textContent = confidenceSlider.value;
  });

  iouSlider.addEventListener("input", () => {
    iouThreshold = Number(iouSlider.value);
    iouValue.textContent = iouSlider.value;
  });

  maskSlider.addEventListener("input", () => {
    maskThreshold = Number(maskSlider.value);
    maskValue.textContent = maskSlider.value;
  });

  frameSkipSlider.addEventListener("input", () => {
    frameSkip = Number(frameSkipSlider.value);
    frameSkipValue.textContent = frameSkipSlider.value;
  });

  bnwToggle.addEventListener("change", () => {
    isBnW = bnwToggle.checked;
  });

  muteToggle.addEventListener("change", () => {
    isMuted = muteToggle.checked;
    sourceVideo.muted = isMuted;
    sourceVideo.volume = isMuted ? 0 : 1;
  });

  modelSelect.addEventListener("change", async () => {
    if (isProcessing) {
      stopProcessing();
    }
    await loadModel(modelSelect.value);
  });

  videoUpload.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (!file) return;

    fileNameEl.textContent = file.name;
    sourceVideo.src = URL.createObjectURL(file);
    sourceVideo.load();
    setStatus("Loading video...");

    const onMetadataLoaded = () => {
      outputCanvas.width = sourceVideo.videoWidth;
      outputCanvas.height = sourceVideo.videoHeight;
      initMaskBuffers(outputCanvas.width, outputCanvas.height);

      processBtn.disabled = !session;
      setStatus(session ? "Video loaded. Click Start Processing." : "Video loaded. Waiting for model.");

      sourceVideo.removeEventListener("loadedmetadata", onMetadataLoaded);
    };

    sourceVideo.addEventListener("loadedmetadata", onMetadataLoaded);

    sourceVideo.onerror = () => {
      console.error("Video load error", sourceVideo.error);
      setStatus("Error loading video file.");
    };
  });

  processBtn.addEventListener("click", async () => {
    if (isProcessing) {
      stopProcessing();
    } else {
      await startProcessing();
    }
  });
}

function boot() {
  wireModalEvents();
  wireControlEvents();
  loadModel(modelSelect.value);
}

boot();
