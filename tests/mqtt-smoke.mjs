import mqtt from "mqtt";

const broker = "wss://broker.emqx.io:8084/mqtt";
const root = "tegar-pi/f55d061723f585b7066faf1e4c2fdd96136568be47fcc43f";
const commandTopic = `${root}/command`;
const statusTopic = `${root}/status`;

const client = mqtt.connect(broker, {
  clientId: `tegar-smoke-${crypto.randomUUID()}`,
  connectTimeout: 10_000,
});

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

client.on("connect", async () => {
  client.subscribe(statusTopic, { qos: 1 });

  for (const command of [
    { mode: "on", intervalMs: 700 },
    { mode: "blink", intervalMs: 250 },
    { mode: "off", intervalMs: 700 },
  ]) {
    client.publish(commandTopic, JSON.stringify(command), { qos: 1 });
    await wait(1_200);
  }

  await wait(500);
  client.end();
});

client.on("message", (_topic, payload) => {
  const status = JSON.parse(payload.toString());
  console.log(
    JSON.stringify({
      online: status.online,
      mode: status.mode,
      intervalMs: status.intervalMs,
    }),
  );
});

client.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
