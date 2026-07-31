"use client";

import mqtt, { type MqttClient } from "mqtt";
import { useCallback, useEffect, useRef, useState } from "react";
import { InstallAppButton } from "./pwa-controls";

const BROKER_URL = "wss://broker.emqx.io:8084/mqtt";
const TOPIC_ROOT =
  "tegar-pi/f55d061723f585b7066faf1e4c2fdd96136568be47fcc43f";
const COMMAND_TOPIC = `${TOPIC_ROOT}/command`;
const STATUS_TOPIC = `${TOPIC_ROOT}/status`;
const ENVIRONMENT_TOPIC = `${TOPIC_ROOT}/environment`;
const CAMERA_BASE_URL = "https://tegar-pi.tailbba591.ts.net";

type LedMode = "on" | "off" | "blink";
type DeviceStatus = {
  online: boolean;
  mode: LedMode;
  intervalMs: number;
  updatedAt?: string;
};

type EnvironmentStatus = {
  online: boolean;
  scannerReady: boolean;
  sensorSeen: boolean;
  dataFresh: boolean;
  model: string;
  address: string;
  temperatureC: number | null;
  humidityPct: number | null;
  batteryPct: number | null;
  rssi: number | null;
  lastSeenSecondsAgo?: number | null;
  lastMeasurementSecondsAgo?: number | null;
  lastMeasurementAt?: string | null;
  updatedAt?: string;
  error?: string | null;
};

type CameraStatus = {
  online: boolean;
  cameraDetected: boolean;
  cameraRunning: boolean;
  streaming: boolean;
  resolution?: string;
  fps?: number;
  captureFps?: number;
  renderFps?: number;
  lastFrameAt?: string | null;
  error?: string | null;
  vision: {
    ready: boolean;
    engine: string;
    inferenceFps: number;
    inferenceMs: number;
    objects: number;
    faces: number;
    labels: string[];
    personPresent: boolean;
    personConfidence: number;
    threshold: number;
    captureIntervalSeconds: number;
    lastEventAt?: string | null;
  };
  captures: CaptureStorage;
};

type CaptureStorage = {
  count: number;
  usedBytes: number;
  limitBytes: number;
};

type PersonEvent = {
  id: string;
  capturedAt: string;
  confidence: number;
  personCount: number;
  sizeBytes: number;
  imageUrl: string;
};

type EventsResponse = {
  events: PersonEvent[];
  storage: CaptureStorage;
  pagination: {
    page: number;
    perPage: number;
    total: number;
    totalPages: number;
  };
};

type HistoryRange = "minute" | "hour" | "day" | "month";

type HistoryPoint = {
  timestamp: string;
  samples: number;
  temperatureC: number;
  temperatureMinC: number;
  temperatureMaxC: number;
  humidityPct: number;
  humidityMinPct: number;
  humidityMaxPct: number;
  batteryPct: number | null;
  rssi: number | null;
};

type HistoryResponse = {
  range: HistoryRange;
  points: HistoryPoint[];
  storage: {
    databaseBytes: number;
    limitBytes: number;
    rollupPoints: number;
    oldestAt: string | null;
    newestAt: string | null;
  };
};

const initialStatus: DeviceStatus = {
  online: false,
  mode: "off",
  intervalMs: 700,
};

const initialEnvironment: EnvironmentStatus = {
  online: false,
  scannerReady: false,
  sensorSeen: false,
  dataFresh: false,
  model: "LYWSD03MMC",
  address: "A4:C1:38:4D:B0:03",
  temperatureC: null,
  humidityPct: null,
  batteryPct: null,
  rssi: null,
};

const initialCamera: CameraStatus = {
  online: false,
  cameraDetected: false,
  cameraRunning: false,
  streaming: false,
  vision: {
    ready: false,
    engine: "OpenCV DNN · NanoDet + YuNet",
    inferenceFps: 0,
    inferenceMs: 0,
    objects: 0,
    faces: 0,
    labels: [],
    personPresent: false,
    personConfidence: 0,
    threshold: 0.6,
    captureIntervalSeconds: 5,
  },
  captures: {
    count: 0,
    usedBytes: 0,
    limitBytes: 500 * 1024 * 1024,
  },
};

function measurementAge(seconds: number | null | undefined) {
  if (seconds === null || seconds === undefined) return "Waiting for first reading";
  if (seconds < 60) return `Updated ${Math.max(1, Math.round(seconds))}s ago`;
  return `Updated ${Math.round(seconds / 60)}m ago`;
}

function clamp(value: number, min = 0, max = 100) {
  return Math.min(max, Math.max(min, value));
}

function climateAssessment(
  temperature: number | null,
  humidity: number | null,
) {
  if (temperature === null || humidity === null) {
    return {
      label: "Collecting room data",
      detail: "Waiting for a complete sensor reading.",
      tone: "waiting",
    };
  }
  if (temperature > 29) {
    return {
      label: "Room feels warm",
      detail: "Cooling or more airflow may improve comfort.",
      tone: "warm",
    };
  }
  if (temperature < 19) {
    return {
      label: "Room feels cool",
      detail: "Temperature is below the usual comfort range.",
      tone: "cool",
    };
  }
  if (humidity > 65) {
    return {
      label: "Humidity is high",
      detail: "Ventilation may help reduce moisture buildup.",
      tone: "humid",
    };
  }
  if (humidity < 35) {
    return {
      label: "Air feels dry",
      detail: "Humidity is below the usual comfort range.",
      tone: "dry",
    };
  }
  return {
    label: "Comfort zone",
    detail: "Temperature and humidity are nicely balanced.",
    tone: "comfortable",
  };
}

function calculateDewPoint(
  temperature: number | null,
  humidity: number | null,
) {
  if (temperature === null || humidity === null || humidity <= 0) return null;
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(humidity / 100) + (a * temperature) / (b + temperature);
  return (b * gamma) / (a - gamma);
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatEventTime(value: string) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
}

function InfoTip({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <details className="info-tip">
      <summary aria-label={`About ${title}`}>i</summary>
      <div className="info-popover">
        <strong>{title}</strong>
        <p>{children}</p>
      </div>
    </details>
  );
}

function formatChartTime(timestamp: string, range: HistoryRange) {
  const date = new Date(timestamp);
  if (range === "month") {
    return new Intl.DateTimeFormat("id-ID", {
      month: "short",
      year: "2-digit",
      timeZone: "Asia/Jakarta",
    }).format(date);
  }
  if (range === "day") {
    return new Intl.DateTimeFormat("id-ID", {
      day: "2-digit",
      month: "short",
      timeZone: "Asia/Jakarta",
    }).format(date);
  }
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta",
  }).format(date);
}

function ClimateHistoryChart({
  points,
  range,
}: {
  points: HistoryPoint[];
  range: HistoryRange;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;

    const draw = () => {
      const width = Math.max(280, parent.clientWidth);
      const height = 250;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.scale(ratio, ratio);
      context.clearRect(0, 0, width, height);

      const padding = { top: 30, right: 44, bottom: 31, left: 44 };
      const plotWidth = width - padding.left - padding.right;
      const plotHeight = height - padding.top - padding.bottom;
      context.font = "10px ui-monospace, SFMono-Regular, monospace";
      context.fillStyle = "#82978d";
      context.strokeStyle = "rgba(155, 255, 198, 0.1)";
      context.lineWidth = 1;

      for (let index = 0; index <= 4; index += 1) {
        const y = padding.top + (plotHeight / 4) * index;
        context.beginPath();
        context.moveTo(padding.left, y);
        context.lineTo(width - padding.right, y);
        context.stroke();
      }

      if (!points.length) {
        context.textAlign = "center";
        context.fillText(
          "Waiting for BLE history",
          width / 2,
          padding.top + plotHeight / 2,
        );
        return;
      }

      const temperatures = points.map((point) => point.temperatureC);
      const humidities = points.map((point) => point.humidityPct);
      const temperatureMin = Math.floor(Math.min(...temperatures) - 1);
      const temperatureMax = Math.ceil(Math.max(...temperatures) + 1);
      const humidityMin = Math.max(0, Math.floor(Math.min(...humidities) - 5));
      const humidityMax = Math.min(100, Math.ceil(Math.max(...humidities) + 5));
      const xAt = (index: number) =>
        padding.left +
        (points.length === 1 ? plotWidth / 2 : (index / (points.length - 1)) * plotWidth);
      const yAt = (value: number, minimum: number, maximum: number) =>
        padding.top +
        plotHeight -
        ((value - minimum) / Math.max(1, maximum - minimum)) * plotHeight;

      const drawSeries = (
        values: number[],
        minimum: number,
        maximum: number,
        color: string,
      ) => {
        context.beginPath();
        values.forEach((value, index) => {
          const x = xAt(index);
          const y = yAt(value, minimum, maximum);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.lineJoin = "round";
        context.lineCap = "round";
        context.stroke();
        const lastIndex = values.length - 1;
        context.fillStyle = color;
        context.beginPath();
        context.arc(
          xAt(lastIndex),
          yAt(values[lastIndex], minimum, maximum),
          3,
          0,
          Math.PI * 2,
        );
        context.fill();
      };

      drawSeries(temperatures, temperatureMin, temperatureMax, "#ffad6a");
      drawSeries(humidities, humidityMin, humidityMax, "#68baff");

      context.textAlign = "left";
      context.fillStyle = "#ffad6a";
      context.fillText(`${temperatureMax}°`, 7, padding.top + 3);
      context.fillText(`${temperatureMin}°`, 7, padding.top + plotHeight);
      context.textAlign = "right";
      context.fillStyle = "#68baff";
      context.fillText(`${humidityMax}%`, width - 7, padding.top + 3);
      context.fillText(`${humidityMin}%`, width - 7, padding.top + plotHeight);
      context.fillStyle = "#82978d";
      context.textAlign = "left";
      context.fillText(
        formatChartTime(points[0].timestamp, range),
        padding.left,
        height - 8,
      );
      context.textAlign = "right";
      context.fillText(
        formatChartTime(points[points.length - 1].timestamp, range),
        width - padding.right,
        height - 8,
      );
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [points, range]);

  return (
    <canvas
      ref={canvasRef}
      className="climate-chart"
      role="img"
      aria-label="Temperature and humidity history chart"
    />
  );
}

export default function Home() {
  const clientRef = useRef<MqttClient | null>(null);
  const [brokerConnected, setBrokerConnected] = useState(false);
  const [device, setDevice] = useState<DeviceStatus>(initialStatus);
  const [environment, setEnvironment] =
    useState<EnvironmentStatus>(initialEnvironment);
  const [camera, setCamera] = useState<CameraStatus>(initialCamera);
  const [cameraRequested, setCameraRequested] = useState(false);
  const [cameraStreamUrl, setCameraStreamUrl] = useState<string | null>(null);
  const [personEvents, setPersonEvents] = useState<PersonEvent[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsDeleting, setEventsDeleting] = useState(false);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [eventsPage, setEventsPage] = useState(1);
  const [eventsPerPage, setEventsPerPage] = useState(20);
  const [eventsPagination, setEventsPagination] = useState({
    page: 1,
    perPage: 20,
    total: 0,
    totalPages: 1,
  });
  const [historyRange, setHistoryRange] = useState<HistoryRange>("minute");
  const [history, setHistory] = useState<HistoryResponse>({
    range: "minute",
    points: [],
    storage: {
      databaseBytes: 0,
      limitBytes: 5 * 1024 * 1024,
      rollupPoints: 0,
      oldestAt: null,
      newestAt: null,
    },
  });
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState<LedMode>("off");
  const [intervalMs, setIntervalMs] = useState(700);
  const [message, setMessage] = useState("Connecting to IoT relay…");

  useEffect(() => {
    const client = mqtt.connect(BROKER_URL, {
      clientId: `tegar-web-${crypto.randomUUID()}`,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 2_000,
    });

    clientRef.current = client;

    client.on("connect", () => {
      setBrokerConnected(true);
      setMessage("Relay connected. Waiting for Raspberry Pi…");
      client.subscribe([STATUS_TOPIC, ENVIRONMENT_TOPIC], { qos: 1 });
    });

    client.on("reconnect", () => {
      setBrokerConnected(false);
      setMessage("Reconnecting to IoT relay…");
    });

    client.on("offline", () => {
      setBrokerConnected(false);
      setMessage("IoT relay is offline.");
    });

    client.on("message", (topic, payload) => {
      try {
        if (topic === STATUS_TOPIC) {
          const next = JSON.parse(payload.toString()) as DeviceStatus;
          setDevice(next);
          setSelectedMode(next.mode);
          setIntervalMs(next.intervalMs);
          setMessage(next.online ? "Device acknowledged the latest state." : "Raspberry Pi is offline.");
        } else if (topic === ENVIRONMENT_TOPIC) {
          setEnvironment(JSON.parse(payload.toString()) as EnvironmentStatus);
        }
      } catch {
        setMessage("Received an unreadable device status.");
      }
    });

    client.on("error", () => {
      setMessage("Unable to reach the IoT relay.");
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, []);

  const refreshEdgeData = useCallback(async (showLoading = false) => {
    if (showLoading) setEventsLoading(true);
    try {
      const healthResponse = await fetch(`${CAMERA_BASE_URL}/health`, {
        cache: "no-store",
      });
      if (!healthResponse.ok) throw new Error("Camera health check failed");
      const next = (await healthResponse.json()) as CameraStatus;
      setCamera((current) => ({ ...current, ...next, error: null }));

      const eventsResponse = await fetch(
        `${CAMERA_BASE_URL}/events?page=${eventsPage}&perPage=${eventsPerPage}`,
        { cache: "no-store" },
      );
      if (!eventsResponse.ok) throw new Error("Person event request failed");
      const eventData = (await eventsResponse.json()) as EventsResponse;
      setPersonEvents(eventData.events);
      setEventsPagination(eventData.pagination);
      if (eventData.pagination.page !== eventsPage) {
        setEventsPage(eventData.pagination.page);
      }
      setCamera((current) => ({ ...current, captures: eventData.storage }));
      setEventsError(null);
    } catch {
      setCamera((current) => ({
        ...current,
        online: false,
        cameraDetected: false,
        cameraRunning: false,
        streaming: false,
        resolution: "640x360",
        fps: 10,
        error: "Connect this device to the same Tailscale network.",
      }));
      setEventsError("Person archive is unreachable through Tailscale.");
    } finally {
      if (showLoading) setEventsLoading(false);
    }
  }, [eventsPage, eventsPerPage]);

  useEffect(() => {
    const initial = window.setTimeout(() => refreshEdgeData(), 0);
    const interval = window.setInterval(() => refreshEdgeData(), 8_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refreshEdgeData]);

  const refreshHistory = useCallback(
    async (showLoading = false) => {
      if (showLoading) setHistoryLoading(true);
      try {
        const response = await fetch(
          `${CAMERA_BASE_URL}/environment/history?range=${historyRange}`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("History request failed");
        setHistory((await response.json()) as HistoryResponse);
        setHistoryError(null);
      } catch {
        setHistoryError("BLE history is unreachable through Tailscale.");
      } finally {
        if (showLoading) setHistoryLoading(false);
      }
    },
    [historyRange],
  );

  useEffect(() => {
    const initial = window.setTimeout(() => refreshHistory(), 0);
    const interval = window.setInterval(() => refreshHistory(), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [refreshHistory]);

  const deleteAllEvents = async () => {
    if (
      !window.confirm(
        `Delete all ${camera.captures.count} person captures from the Raspberry Pi? This cannot be undone.`,
      )
    ) {
      return;
    }
    setEventsDeleting(true);
    setEventsError(null);
    try {
      const response = await fetch(`${CAMERA_BASE_URL}/events`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Delete request failed");
      const result = (await response.json()) as {
        deleted: number;
        storage: CaptureStorage;
      };
      setPersonEvents([]);
      setEventsPage(1);
      setEventsPagination({
        page: 1,
        perPage: eventsPerPage,
        total: 0,
        totalPages: 1,
      });
      setCamera((current) => ({ ...current, captures: result.storage }));
      setMessage(`${result.deleted} person captures deleted from tegar-pi.`);
    } catch {
      setEventsError("Could not delete captures through Tailscale.");
    } finally {
      setEventsDeleting(false);
    }
  };

  const sendCommand = useCallback(
    (mode: LedMode, nextInterval = intervalMs) => {
      const client = clientRef.current;
      if (!client?.connected) {
        setMessage("The relay is not connected yet.");
        return;
      }

      setSelectedMode(mode);
      setMessage(`Sending ${mode.toUpperCase()} command…`);
      client.publish(
        COMMAND_TOPIC,
        JSON.stringify({
          mode,
          intervalMs: nextInterval,
          sentAt: new Date().toISOString(),
        }),
        { qos: 1, retain: false },
      );
    },
    [intervalMs],
  );

  const handleInterval = (value: number) => {
    setIntervalMs(value);
    if (selectedMode === "blink") {
      sendCommand("blink", value);
    }
  };

  const setCameraStream = (next: boolean) => {
    setCameraRequested(next);
    setCameraStreamUrl(
      next ? `${CAMERA_BASE_URL}/stream.mjpg?ts=${Date.now()}` : null,
    );
    setCamera((current) => ({ ...current, streaming: false, error: null }));
    setMessage(next ? "Opening private Tailscale camera…" : "Camera feed stopped.");
  };

  const blinkFrequency = (1000 / intervalMs).toFixed(1);
  const deviceOnline = brokerConnected && device.online;
  const climate = climateAssessment(
    environment.temperatureC,
    environment.humidityPct,
  );
  const dewPoint = calculateDewPoint(
    environment.temperatureC,
    environment.humidityPct,
  );
  const temperatureLevel =
    environment.temperatureC === null
      ? 0
      : clamp(((environment.temperatureC - 10) / 25) * 100);
  const humidityLevel =
    environment.humidityPct === null ? 0 : clamp(environment.humidityPct);
  const storageLevel = clamp(
    (camera.captures.usedBytes / Math.max(1, camera.captures.limitBytes)) * 100,
  );
  const estimatedCaptureCapacity =
    camera.captures.count > 0 && camera.captures.usedBytes > 0
      ? Math.floor(
          camera.captures.limitBytes /
            (camera.captures.usedBytes / camera.captures.count),
        )
      : null;
  const captureRangeStart =
    eventsPagination.total === 0
      ? 0
      : (eventsPagination.page - 1) * eventsPagination.perPage + 1;
  const captureRangeEnd = Math.min(
    eventsPagination.total,
    eventsPagination.page * eventsPagination.perPage,
  );
  const latestHistoryPoint = history.points.at(-1) ?? null;
  const historyStorageLevel = clamp(
    (history.storage.databaseBytes / Math.max(1, history.storage.limitBytes)) *
      100,
  );

  return (
    <main className="app-shell">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />

      <header className="topbar">
        <div>
          <p className="eyebrow">Remote IoT console</p>
          <h1>Tegar Pi Control</h1>
        </div>
        <div className="topbar-actions">
          <InstallAppButton />
          <div className={`status-pill ${deviceOnline ? "online" : ""}`}>
            <span className="status-dot" />
            {deviceOnline
              ? "Pi online"
              : brokerConnected
                ? "Pi offline"
                : "Relay offline"}
          </div>
        </div>
      </header>

      <section className="dashboard">
        <article className="control-card">
          <div className="card-heading">
            <div>
              <p className="section-label">Onboard indicator</p>
              <h2>ACT LED</h2>
            </div>
            <span className="device-tag">tegar-pi</span>
          </div>

          <div className="led-stage">
            <div
              className={`led-orbit mode-${selectedMode}`}
              style={{ "--blink-duration": `${intervalMs * 2}ms` } as React.CSSProperties}
            >
              <div className="led-core" />
            </div>
            <p className="mode-readout">{selectedMode}</p>
            <p className="mode-caption">
              {selectedMode === "blink"
                ? `${blinkFrequency} pulses per second`
                : selectedMode === "on"
                  ? "Indicator held on"
                  : "Indicator held off"}
            </p>
          </div>

          <div className="mode-grid" role="group" aria-label="LED mode">
            {(["off", "on", "blink"] as LedMode[]).map((mode) => (
              <button
                key={mode}
                className={`mode-button ${selectedMode === mode ? "active" : ""}`}
                onClick={() => sendCommand(mode)}
                disabled={!brokerConnected}
              >
                <span className={`mode-icon icon-${mode}`} />
                {mode}
              </button>
            ))}
          </div>

          <div className={`slider-panel ${selectedMode !== "blink" ? "muted" : ""}`}>
            <div className="slider-copy">
              <div>
                <p className="section-label">Blink intensity</p>
                <h3>{intervalMs} ms</h3>
              </div>
              <span>{blinkFrequency} Hz</span>
            </div>
            <input
              aria-label="Blink interval"
              type="range"
              min="100"
              max="2000"
              step="100"
              value={intervalMs}
              onChange={(event) => handleInterval(Number(event.target.value))}
              disabled={selectedMode !== "blink" || !brokerConnected}
            />
            <div className="range-labels">
              <span>Fast</span>
              <span>Slow</span>
            </div>
          </div>
        </article>

        <aside className="side-column">
          <article className="info-card">
            <div className="compact-heading">
              <p className="section-label">Connection path</p>
              <InfoTip title="Connection path">
                LED commands and climate telemetry travel through MQTT. Camera,
                capture, and history data stay behind private Tailscale HTTPS.
              </InfoTip>
            </div>
            <div className="path-list">
              <div className="path-node active">
                <span className="node-index">01</span>
                <div>
                  <strong>Web console</strong>
                  <small>{brokerConnected ? "Connected securely" : "Connecting…"}</small>
                </div>
              </div>
              <div className="path-line" />
              <div className="path-node active">
                <span className="node-index">02</span>
                <div>
                  <strong>MQTT relay</strong>
                  <small>Internet command channel</small>
                </div>
              </div>
              <div className="path-line" />
              <div className={`path-node ${deviceOnline ? "active" : ""}`}>
                <span className="node-index">03</span>
                <div>
                  <strong>Raspberry Pi</strong>
                  <small>{deviceOnline ? "Listening now" : "Awaiting device"}</small>
                </div>
              </div>
            </div>
          </article>

          <article className="info-card telemetry-card">
            <div className="telemetry-row">
              <span>Command state</span>
              <strong>{device.mode.toUpperCase()}</strong>
            </div>
            <div className="telemetry-row">
              <span>Round-trip status</span>
              <strong>{deviceOnline ? "Ready" : "Waiting"}</strong>
            </div>
            <div className="telemetry-row">
              <span>Transport</span>
              <strong>WSS · MQTT</strong>
            </div>
          </article>
        </aside>
      </section>

      <section className={`environment-card ${environment.dataFresh ? "has-data" : ""}`}>
        <div className="environment-heading">
          <div>
            <div className="climate-title-row">
              <p className="section-label">BLE environment sensor</p>
              <span className="sensor-model">{environment.model}</span>
            </div>
            <div className="title-with-info">
              <h2>Room climate</h2>
              <InfoTip title="BLE climate">
                The Pi decrypts current Xiaomi advertisements and stores new
                readings locally. History begins from the moment storage was
                enabled; the sensor cannot provide older readings retroactively.
              </InfoTip>
            </div>
          </div>
          <div
            className={`sensor-status ${
              environment.online && environment.scannerReady ? "online" : ""
            }`}
          >
            <span />
            {!environment.online
              ? "Gateway offline"
              : !environment.scannerReady
                ? "Scanner waiting"
                : environment.sensorSeen
                  ? "Sensor connected"
                  : "Waiting for sensor"}
          </div>
        </div>

        <div className={`climate-insight ${climate.tone}`}>
          <span className="insight-mark" />
          <div>
            <strong>{climate.label}</strong>
          </div>
          <InfoTip title={climate.label}>{climate.detail}</InfoTip>
          <span className="insight-freshness">
            {measurementAge(environment.lastMeasurementSecondsAgo)}
          </span>
        </div>

        <div className="climate-grid">
          <article className="climate-reading temperature-reading">
            <span className="climate-icon">°</span>
            <div className="climate-reading-body">
              <small>Temperature</small>
              <strong>
                {environment.temperatureC === null
                  ? "—"
                  : environment.temperatureC.toFixed(1)}
                <span>°C</span>
              </strong>
              <div className="climate-meter temperature-meter">
                <span
                  style={
                    { "--level": `${temperatureLevel}%` } as React.CSSProperties
                  }
                />
              </div>
              <small className="climate-range">10° cool · 35° warm</small>
            </div>
          </article>
          <article className="climate-reading humidity-reading">
            <span className="climate-icon">%</span>
            <div className="climate-reading-body">
              <small>Relative humidity</small>
              <strong>
                {environment.humidityPct === null
                  ? "—"
                  : environment.humidityPct.toFixed(1)}
                <span>%</span>
              </strong>
              <div className="climate-meter humidity-meter">
                <span
                  style={
                    { "--level": `${humidityLevel}%` } as React.CSSProperties
                  }
                />
              </div>
              <small className="climate-range">35% dry · 65% humid</small>
            </div>
          </article>
        </div>

        <div className="environment-telemetry">
          <div>
            <span>Dew point</span>
            <strong>{dewPoint === null ? "—" : `${dewPoint.toFixed(1)}°C`}</strong>
          </div>
          <div>
            <span>Battery</span>
            <strong>
              {environment.batteryPct === null ? "—" : `${environment.batteryPct}%`}
            </strong>
          </div>
          <div>
            <span>BLE signal</span>
            <strong>{environment.rssi === null ? "—" : `${environment.rssi} dBm`}</strong>
          </div>
          <div>
            <span>BLE address</span>
            <strong>{environment.address}</strong>
          </div>
        </div>
        {environment.error && (
          <p className="environment-error">{environment.error}</p>
        )}
      </section>

      <section className="history-card">
        <div className="history-heading">
          <div>
            <p className="section-label">Stored on tegar-pi</p>
            <div className="title-with-info">
              <h2>Climate history</h2>
              <InfoTip title="Historical rollups">
                Minute data is retained for seven days, hourly for 120 days,
                daily for five years, and monthly summaries are kept within the
                same 5 MiB SQLite budget.
              </InfoTip>
            </div>
          </div>
          <div className="history-range" role="group" aria-label="History range">
            {(["minute", "hour", "day", "month"] as HistoryRange[]).map(
              (range) => (
                <button
                  key={range}
                  className={historyRange === range ? "active" : ""}
                  onClick={() => setHistoryRange(range)}
                >
                  {range[0].toUpperCase() + range.slice(1)}
                </button>
              ),
            )}
          </div>
        </div>

        <div className="history-legend">
          <span className="temperature-key">Temperature</span>
          <span className="humidity-key">Humidity</span>
          <button
            onClick={() => refreshHistory(true)}
            disabled={historyLoading}
            aria-label="Refresh climate history"
          >
            {historyLoading ? "…" : "↻"}
          </button>
        </div>
        <div className="chart-shell">
          <ClimateHistoryChart points={history.points} range={historyRange} />
        </div>
        <div className="history-footer">
          <div>
            <span>Latest</span>
            <strong>
              {latestHistoryPoint
                ? `${latestHistoryPoint.temperatureC.toFixed(1)}° · ${latestHistoryPoint.humidityPct.toFixed(1)}%`
                : "Collecting"}
            </strong>
          </div>
          <div>
            <span>Rollups</span>
            <strong>{history.storage.rollupPoints}</strong>
          </div>
          <div>
            <span>Database</span>
            <strong>
              {formatBytes(history.storage.databaseBytes)} / 5 MB
            </strong>
          </div>
          <div className="history-storage-mini">
            <span style={{ width: `${historyStorageLevel}%` }} />
          </div>
        </div>
        {historyError && <p className="environment-error">{historyError}</p>}
      </section>

      <section className="camera-card">
        <div className="camera-heading">
          <div>
            <p className="section-label">Remote camera</p>
            <div className="title-with-info">
              <h2>Pi webcam</h2>
              <InfoTip title="Private edge camera">
                Frames are annotated on the Raspberry Pi and delivered over
                Tailscale. Object inference runs every two seconds while the
                video stream remains at ten frames per second.
              </InfoTip>
            </div>
          </div>
          <div className={`camera-status ${camera.streaming ? "live" : ""}`}>
            <span />
            {!camera.online
              ? "Camera agent offline"
              : !camera.cameraDetected
                ? "Webcam missing"
                : camera.streaming
                  ? `Live · ${camera.fps ?? 2} FPS`
                  : "Camera ready"}
          </div>
        </div>

        <div className="camera-viewport">
          {cameraStreamUrl ? (
            // The native img element is required for the live MJPEG stream.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={cameraStreamUrl}
              alt="Edge-annotated live view from the Raspberry Pi webcam"
              onLoad={() =>
                setCamera((current) => ({ ...current, streaming: true, error: null }))
              }
              onError={() => {
                setCameraRequested(false);
                setCameraStreamUrl(null);
                setCamera((current) => ({
                  ...current,
                  streaming: false,
                  error: "Private camera is unreachable. Check Tailscale connection.",
                }));
              }}
            />
          ) : (
            <div className="camera-placeholder">
              <span className="camera-lens" />
              <strong>{camera.cameraDetected ? "Camera is standing by" : "Waiting for webcam"}</strong>
              <small>Start the feed to request live snapshots from tegar-pi.</small>
            </div>
          )}
          {cameraRequested && !camera.streaming && (
            <div className="camera-loading">Requesting camera…</div>
          )}
          {camera.streaming && <span className="live-badge">LIVE</span>}
          {camera.vision.ready && (
            <span className="vision-badge">
              EDGE AI · {camera.vision.inferenceFps.toFixed(1)} FPS
            </span>
          )}
        </div>

        <div className="camera-controls">
          <div>
            <strong>{camera.resolution ?? "640x360"}</strong>
            <small>
              Private Tailscale MJPEG · {camera.fps ?? 10} FPS target
            </small>
          </div>
          <button
            className={`camera-button ${cameraRequested ? "stop" : ""}`}
            onClick={() => setCameraStream(!cameraRequested)}
            disabled={!camera.online || !camera.cameraDetected}
          >
            {cameraRequested ? "Stop camera" : "Start camera"}
          </button>
        </div>

        <div className={`vision-panel ${camera.vision.ready ? "enabled" : ""}`}>
          <div className="vision-heading">
            <div>
              <span className="vision-kicker">Raspberry Pi edge computing</span>
              <strong>Pi-side scene intelligence</strong>
            </div>
            <div className="vision-heading-actions">
              <InfoTip title="Edge inference">
                NanoDet detects common objects and YuNet locates face regions.
                No identity recognition runs on the Pi.
              </InfoTip>
              <span
                className={`edge-state ${
                  camera.vision.personPresent ? "alert" : ""
                }`}
              >
                {camera.vision.personPresent
                  ? `Person ${Math.round(camera.vision.personConfidence * 100)}%`
                  : camera.vision.ready
                    ? "Vision running"
                    : "Vision starting"}
              </span>
            </div>
          </div>

          <div className="edge-metrics">
            <div className="vision-count">
              <span>Video stream</span>
              <strong>{camera.renderFps?.toFixed(1) ?? "—"}</strong>
              <small>frames/sec</small>
            </div>
            <div className="vision-count">
              <span>AI inference</span>
              <strong>{camera.vision.inferenceFps.toFixed(1)}</strong>
              <small>{camera.vision.inferenceMs || "—"} ms/frame</small>
            </div>
            <div className="vision-count">
              <span>Objects</span>
              <strong>{camera.vision.objects}</strong>
              <small>NanoDet · COCO</small>
            </div>
            <div className="vision-count">
              <span>Faces</span>
              <strong>{camera.vision.faces}</strong>
              <small>YuNet · no identity</small>
            </div>
          </div>

          <div className="vision-results">
            <span>Current scene</span>
            <strong>
              {camera.vision.labels.length
                ? camera.vision.labels.join(" · ")
                : camera.vision.ready
                  ? "No recognized objects"
                  : "Models are loading"}
            </strong>
            <InfoTip title="Detection threshold">
              Person captures trigger at ≥
              {Math.round(camera.vision.threshold * 100)}% confidence. While a
              person remains visible, another capture can be saved every{" "}
              {camera.vision.captureIntervalSeconds} seconds.
            </InfoTip>
          </div>
        </div>
        {camera.error && <p className="camera-error">{camera.error}</p>}
      </section>

      <section className="capture-card">
        <div className="capture-heading">
          <div>
            <p className="section-label">Person event archive</p>
            <div className="title-with-info">
              <h2>Detection captures</h2>
              <InfoTip title="Capture retention">
                A new image can be saved every{" "}
                {camera.vision.captureIntervalSeconds} seconds while a person is
                detected above 60% confidence. The oldest files are removed
                after 500 MiB.
                {estimatedCaptureCapacity
                  ? ` Current image sizes indicate room for roughly ${estimatedCaptureCapacity.toLocaleString("id-ID")} captures.`
                  : ""}
              </InfoTip>
            </div>
          </div>
          <div className="capture-actions">
            <button
              className="capture-refresh"
              onClick={() => refreshEdgeData(true)}
              disabled={eventsLoading || eventsDeleting}
            >
              {eventsLoading ? "Refreshing…" : "Refresh"}
            </button>
            <button
              className="capture-delete"
              onClick={deleteAllEvents}
              disabled={!personEvents.length || eventsDeleting}
            >
              {eventsDeleting ? "Deleting…" : "Delete all"}
            </button>
          </div>
        </div>

        <div className="storage-summary">
          <div>
            <span>Pi storage used</span>
            <strong>
              {formatBytes(camera.captures.usedBytes)} /{" "}
              {formatBytes(camera.captures.limitBytes)}
            </strong>
          </div>
          <span>{camera.captures.count} captures retained</span>
        </div>
        <div className="storage-meter" aria-label={`${storageLevel}% storage used`}>
          <span style={{ width: `${storageLevel}%` }} />
        </div>

        {personEvents.length ? (
          <div className="capture-grid">
            {personEvents.map((event, index) => (
              <article className="capture-event" key={event.id}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`${CAMERA_BASE_URL}${event.imageUrl}`}
                  alt={`Person detected at ${formatEventTime(event.capturedAt)}`}
                  loading="lazy"
                />
                {eventsPagination.page === 1 && index === 0 && (
                  <span className="capture-latest">Latest</span>
                )}
                <div className="capture-event-copy">
                  <span>{formatEventTime(event.capturedAt)}</span>
                  <strong>{Math.round(event.confidence * 100)}% person</strong>
                  <small>
                    {event.personCount} detected · {formatBytes(event.sizeBytes)}
                  </small>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="capture-empty">
            <span>00</span>
            <strong>No person events captured yet</strong>
            <small>
              The Pi is watching locally and will add the first event here.
            </small>
          </div>
        )}
        {eventsPagination.total > 0 && (
          <div className="capture-pagination">
            <label>
              <span>Per page</span>
              <select
                value={eventsPerPage}
                onChange={(event) => {
                  setEventsPage(1);
                  setEventsPerPage(Number(event.target.value));
                }}
                aria-label="Captures per page"
              >
                {[10, 20, 50, 100].map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
            <span className="capture-page-summary">
              {captureRangeStart}–{captureRangeEnd} of{" "}
              {eventsPagination.total.toLocaleString("id-ID")}
            </span>
            <div className="capture-page-buttons">
              <button
                onClick={() => setEventsPage((page) => Math.max(1, page - 1))}
                disabled={eventsPagination.page <= 1 || eventsLoading}
                aria-label="Previous capture page"
              >
                Previous
              </button>
              <span>
                {eventsPagination.page} / {eventsPagination.totalPages}
              </span>
              <button
                onClick={() =>
                  setEventsPage((page) =>
                    Math.min(eventsPagination.totalPages, page + 1),
                  )
                }
                disabled={
                  eventsPagination.page >= eventsPagination.totalPages ||
                  eventsLoading
                }
                aria-label="Next capture page"
              >
                Next
              </button>
            </div>
          </div>
        )}
        {eventsError && <p className="camera-error">{eventsError}</p>}
      </section>

      <footer className="activity-bar">
        <span className={`activity-light ${deviceOnline ? "online" : ""}`} />
        <p>{message}</p>
        <span className="prototype-badge">Prototype relay</span>
      </footer>
    </main>
  );
}
