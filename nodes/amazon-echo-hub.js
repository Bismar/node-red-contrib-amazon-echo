// nodes/amazon-echo-hub.js
// Amazon Echo Hub (HA Entities variant) — safe to load alongside the original module.
// Rename type: "amazon-echo-hub-ha-entities"

module.exports = function (RED) {
  function AmazonEchoHubNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    // Persisted config
    node.name    = config.name || "";
    node.port    = Number(config.port || 80);
    node.process = (config.process !== false); // default true

    // Internal state (add your server, sockets, etc.)
    node._server = null;
    node._started = false;

    // Start your underlying hub server (UPnP/SSDP, etc.)
    startServer().catch(err => node.error("Hub start error: " + err.message));

    // Handle input: mirror the original “process input” behaviour
    node.on("input", (msg, send, done) => {
      const _send = send || node.send.bind(node);
      const _done = done || function(){};

      try {
        if (node.process) {
          // Insert your hub's routing/processing here.
          // For now, pass-through to keep parity with "Process input" = true.
          _send(msg);
        } else {
          // If not processing inputs, you could ignore or still pass-through
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

    // ---- DISCOVERY ----
    // Editor “Run discovery now” button calls an admin endpoint that lands here:
    node.doDiscovery = async function() {
      node.status({ fill: "blue", shape: "dot", text: "discovering…" });
      try {
        // TODO: replace this with the module's real discovery routine.
        // If you used SSDP/UPnP broadcast in the original, call it here.
        await simulateWork(1200);
        node.log("Amazon Echo Hub (HA) discovery cycle completed.");
        node.status({ fill: "green", shape: "dot", text: "ready" });
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: "discovery failed" });
        throw e;
      }
    };

    // ---- helpers ----
    async function startServer() {
      if (node._started) return;
      node.status({ fill: "yellow", shape: "ring", text: "starting…" });

      // TODO: wire up the real server from the original project, e.g.:
      // node._server = await createEchoServer({ port: node.port, ... });
      await simulateWork(300); // placeholder async

      node._started = true;
      node.log(`Amazon Echo Hub (HA) listening on port ${node.port}`);
      node.status({ fill: "green", shape: "dot", text: "ready" });
    }

    async function stopServer() {
      node.status({ fill: "grey", shape: "ring", text: "stopping…" });
      try {
        // TODO: close sockets, servers, timers, etc.
        await simulateWork(100);
      } finally {
        node._server = null;
        node._started = false;
        node.status({});
      }
    }

    function simulateWork(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }
  }

  RED.nodes.registerType("amazon-echo-hub-ha-entities", AmazonEchoHubNode);

  // -------- Admin endpoint: trigger discovery from editor button --------
  // POST /amazon-echo-ha-entities/discover  { id: <nodeId> }
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
};
