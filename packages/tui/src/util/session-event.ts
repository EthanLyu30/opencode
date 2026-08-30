type DeletedSessionProperties = {
  readonly [key: string]: unknown
  readonly sessionID?: unknown
  readonly info?: { readonly id?: unknown }
}

export function deletedSessionID(properties: DeletedSessionProperties) {
  if (typeof properties.sessionID === "string") return properties.sessionID
  return typeof properties.info?.id === "string" ? properties.info.id : undefined
}
