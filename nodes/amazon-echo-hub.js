/**
 * Amazon Echo Hub (HA Entities version)
 * Based on node-red-contrib-amazon-echo
 */

module.exports = function (RED) {
  function AmazonEchoHubNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;

    node.port = config.port || 80;
    node.devices = config.devices || [];

    // Example: startup log for clarity
    node.log(`Amazon Echo Hub (HA Entities) started on port ${node.port}`);

    // Simulate handling discovery / Alexa interactions
    node.on("input", function (msg, send, done) {
      // In a full implementation, you'd route discovery/control traffic
      // through here and map to the configured devices
      node.send(msg);
      if (done) done();
    });

    node.on("close", function () {
      node.log("Amazon Echo Hub (HA Entities) stopped");
    });
  }

  RED.nodes.registerType("amazon-echo-hub-ha-entities", AmazonEchoHubNode);
};
