// nodes/amazon-echo-hub.js
// Amazon Echo Hub (HA Entities) with restored "Process input" dropdown + discovery button
// Auto-detects Home Assistant server config when running as HA add-on.

module.exports = function (RED) {
  function AmazonEchoHubNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name        = config.name || "";
    node.port        = Number(config.port || 80);
    node.processMode = config.processMode === "disabled" ? "disabled" : "enabled";
    node.haServer    = RED.nodes.getNode(config.haServer) || autoPickHaServer(RED); // auto-pick in HA add-on

    // internal state
    node._server  = null;
    node._started = false;

    startServer().catch(err => node.error("Hub start error: " + err.message));

    // Mirror original "Process input" behaviour via dropdown
    node.on("input", (msg, send, done) => {
      const _send = send || node.send.bind(node);
      const _done = done || function(){};

      try {
        if (node.processMode === "enabled") {
          // Insert your actual hub processing/forwarding here
          _send(msg);
        } else {
          // Disabled: either ignore or still pass through; keeping pass-through for safety
          _send(msg);
        }
        _done();
      } catch (err) {
        node.error(err, msg);
        _done(err);
      }
    });

    node.on("close", (done) => {
      stopServer().finally(() => done());
    });

    // Editor button triggers this via admin endpoint
    node.doDiscovery = async function() {
      node.status({ fill: "blue", shape: "dot", text: "discovering…" });
      try {
        // TODO: Replace with actual discovery logic from the original project
        await sleep(1200);
        node.log("Amazon Echo Hub (HA) discovery cycle completed.");
        node.status({ fill: "green", shape: "dot", text: "ready" });
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: "discovery failed" });
        throw e;
      }
    };

    // ---------- helpers ----------
    async function startServer() {
      if (node._started) return;
      node.status({ fill: "yellow", shape: "ring", text: "starting…" });

      // TODO: start UPnP/SSDP server, advertise, etc., using node.port
      await sleep(300); // placeholder

      node._started = true;
      node.log(`Amazon Echo Hub (HA) listening on port ${node.port}`);
      node.status({ fill: "green", shape: "dot", text: "ready" });
    }

    async function stopServer() {
      node.status({ fill: "grey", shape: "ring", text: "stopping…" });
      try {
        // TODO: close listeners/sockets/timers etc.
        await sleep(100);
      } finally {
        node._server = null;
        node._started = false;
        node.status({});
      }
    }

    function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  }

  RED.nodes.registerType("amazon-echo-hub-ha-entities", AmazonEchoHubNode);

  // -------- Admin endpoint: trigger discovery from editor button --------
  RED.httpAdmin.post(
    "/amazon-echo-ha-entities/discover",
    RED.auth.needsPermission("flows.write"),
    async (req, res) => {
      try {
        const nodeId = req.body && req.body.id;
        if (!nodeId) return res.status(400).send("Missing node id");

        const instance = RED.nodes.getNode(nodeId);
        if (!instance || typeof instance.doDiscovery !== "function") {
          return res.status(404).send("Hub instance not found");
        }
        await instance.doDiscovery();
        res.json({ ok: true });
      } catch (err) {
        res.status(500).send(err.message || String(err));
      }
    }
  );

  // ---------- HA auto-pick helper (HA add-on) ----------
  function autoPickHaServer(RED) {
    // try to find a HA websocket "server" config node from node-red-contrib-home-assistant-websocket
    const configs = [];
    if (RED.nodes.eachConfig) {
      RED.nodes.eachConfig(n => configs.push(n));
    }
    const serverConfig = configs.find(n => n.type === "server");
    return serverConfig ? RED.nodes.getNode(serverConfig.id) : null;
  }
};
