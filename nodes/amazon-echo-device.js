/**
 * Amazon Echo Device (HA Entities version)
 * Based on node-red-contrib-amazon-echo
 */

module.exports = function (RED) {
  function AmazonEchoDeviceNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.name = config.name;
    node.topic = config.topic;
    node.deviceType = config.deviceType;
    node.haDeviceId = config.haDeviceId || "";
    node.haEntityId = config.haEntityId || "";

    // Handle input messages
    node.on("input", function (msg, send, done) {
      // Example: append HA linkage info to outgoing payload
      if (msg && msg.deviceid && msg.deviceid === node.id) {
        if (typeof msg.payload !== "object" || msg.payload === null) {
          msg.payload = { value: msg.payload };
        }

        msg.payload.haDeviceId = node.haDeviceId || "";
        msg.payload.haEntityId = node.haEntityId || "";

        node.send(msg);
      }

      if (done) done();
    });

    node.on("close", function () {
      // cleanup if needed
    });
  }

  // Register with new unique node type name
  RED.nodes.registerType("amazon-echo-device-ha-entities", AmazonEchoDeviceNode);
};
