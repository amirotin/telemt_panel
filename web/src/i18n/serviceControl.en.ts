export const serviceControlEn = {
  title: "Telemt service",
  host: "On the panel host",
  customManager: "Custom commands",
  binding: "Service / container",
  notConfigured: "not configured",
  running: "Running",
  stopped: "Stopped",
  failed: "Failed",
  activating: "Starting",
  deactivating: "Stopping",
  reloading: "Reloading configuration",
  logs: "Open Telemt logs",
  unknown: "Status unknown",
  separate:
    "This is the service state on the panel host, not Telemt API availability. When connected to a remote API, check which service you are managing.",
  unknownNote:
    "Status unknown: the system does not expose reliable state or it could not be read. API connectivity is not used as a substitute for service state.",
  busy: "Another service or update operation is running. Wait for it to finish.",
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  confirmStart: "Start Telemt",
  confirmStop: "Stop Telemt",
  confirmRestart: "Restart Telemt",
  startNote:
    "A start command will be sent to the configured service. Boot startup settings are unchanged.",
  stopNote:
    "All active connections to this Telemt instance will end. New connections will not be possible until it starts again.",
  restartNote: "The service will restart. Active connections may be interrupted.",
  manual: "Automatic control unavailable",
  manualNote:
    "Run the command on the host yourself or configure exact sudo permissions. Existing restart/update rights remain usable; the additional start/stop rights are checked separately when the panel starts.",
  noCommand:
    "The service manager or Telemt binding is not configured. The panel does not create remote management automatically.",
  conflict:
    "Telemt and the panel refer to the same service. Start and stop are disabled to avoid stopping the panel itself.",
  accepted: "Command completed. Checking service state.",
  recheck:
    "If the result is unclear, check service state before retrying. Commands are not retried automatically.",
  refresh: "Refresh state",
  rights: "Manual",
} as const;
