process.stdout.write(
  JSON.stringify({
    schemaVersion: 1,
    assertions: [
      { id: "loads", mandatory: true, passed: true, weight: 3 },
      { id: "filters", mandatory: false, passed: false, weight: 1 },
    ],
  }),
)
