// Tests must never provision banks on the user's real Hindsight instance.
// Integration tests construct their own ProjectMemoryService with a loopback test server.
process.env.SCHOLARPEN_HINDSIGHT_DISABLED = "1";
