// nodes/amazon-echo-hub.js
// Amazon Echo Hub (HA Entities) with 4-option process mode + discovery toggle
module.exports = function (RED) {
  function AmazonEchoHubNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name             = config.name || "";
    node.port             = Number(config.port || 80);
    node.processMode      = ["disabled","commands","discovery","all"].includes(config.processMode) ? config.processMode : "all";
    node.discoveryEnabled = (config.discoveryEnabled !== false);
    node.haServer         = RED.nodes.getNode(config.haServer) || null;  // required in HTML

    node._server  = null;
    node._started = false;

    startServer().catch(err => node.error("Hub start error: " + err.message));

    node.on("input", (msg, send, done) => {
      const _send = send || node.send.bind(node);
      const _done = done || function(){};

      try {
        const isCmd  = isCommandMsg(msg);
        const isDisc = isDiscoveryMsg(msg);

        let act = false;
        switch (node.processMode) {
          case "disabled":  act = false; break;
          case "commands":  act = isCmd; break;
          case "discovery": act = isDisc; break;
          case "all":       act = (isCmd || isDisc); break;
        }

        if (act) {
          if (isDisc && node.discoveryEnabled) {
            node.doDiscovery().catch(e => node.error("Discovery failed: " + e.message));
          }
          _send(msg);
        } else {
          _send(msg);
        }
        _done();
      } catch (err) {
        node.error(err, msg);
        _done(err);
      }
    });

    node.on("close", (done) => { stopServer().finally(() => done()); });

    node.doDiscovery = async function() {
      if (!node.discoveryEnabled) {
        node.warn("Discovery requested but device discovery is disabled.");
        return;
      }
      node.status({ fill: "blue", shape: "dot", text: "discovering…" });
      try {
        // TODO: real discovery routine here
        await sleep(1200);
        node.log("Amazon Echo Hub (HA) discovery cycle completed.");
        node.status({ fill: "green", shape: "dot", text: "ready" });
      } catch (e) {
        node.status({ fill: "red", shape: "ring", text: "discovery failed" });
        throw e;
      }
    };

    async function startServer() {
      if (node._started) return;
      node.status({ fill: "yellow", shape: "ring", text: "starting…" });
      // TODO: start UPnP/SSDP server here using node.port
      await sleep(300);
      node._started = true;
      node.log(`Amazon Echo Hub (HA) listening on port ${node.port}`);
      node.status({ fill: "green", shape: "dot", text: "ready" });
    }

    async function stopServer() {
      node.status({ fill: "grey", shape: "ring", text: "stopping…" });
      try {
        // TODO: shutdown sockets/listeners
        await sleep(100);
      } finally {
        node._server = null;
        node._started = false;
        node.status({});
      }
    }

    function isCommandMsg(msg) {
      const p = msg && msg.payload;
      if (p == null) return false;
      if (typeof p === "string") {
        const s = p.toLowerCase();
        return s === "on" || s === "off" || s === "toggle" || /^bri[ghtness]?[:\s]\d+/.test(s);
      }
      if (typeof p === "number") return true;
      if (typeof p === "object") {
        if ("on" in p || "off" in p || "state" in p || "brightness" in p || "level" in p) return true;
      }
      return false;
    }

    function isDiscoveryMsg(msg) {
      const p = msg && msg.payload;
      const t = msg && msg.topic;
      if (t && /discover|discovery/i.test(String(t))) return true;
      if (typeof p === "string" && /^(discover|discovery)$/i.test(p)) return true;
      if (typeof p === "object" && p && (p.discover === true || p.discovery === true)) return true;
      return false;
    }

    function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
  }

  RED.nodes.registerType("amazon-echo-hub-ha-entities", AmazonEchoHubNode);

  // Admin endpoint for manual discovery button
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
