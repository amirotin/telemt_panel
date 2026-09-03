type PublicKeyOptionsJSON = Record<string, unknown>;

function decodeBase64URL(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function encodeBase64URL(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function credentialDescriptors(value: unknown): PublicKeyCredentialDescriptor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const descriptor = item as Record<string, unknown>;
    return {
      ...descriptor,
      id: decodeBase64URL(String(descriptor["id"])),
    } as PublicKeyCredentialDescriptor;
  });
}

export function creationOptionsFromJSON(json: PublicKeyOptionsJSON): PublicKeyCredentialCreationOptions {
  const user = json["user"] as Record<string, unknown>;
  return {
    ...json,
    challenge: decodeBase64URL(String(json["challenge"])),
    user: { ...user, id: decodeBase64URL(String(user["id"])) },
    excludeCredentials: credentialDescriptors(json["excludeCredentials"]),
  } as PublicKeyCredentialCreationOptions;
}

export function requestOptionsFromJSON(json: PublicKeyOptionsJSON): PublicKeyCredentialRequestOptions {
  return {
    ...json,
    challenge: decodeBase64URL(String(json["challenge"])),
    allowCredentials: credentialDescriptors(json["allowCredentials"]),
  } as PublicKeyCredentialRequestOptions;
}

function commonCredentialJSON(credential: PublicKeyCredential) {
  return {
    id: credential.id,
    rawId: encodeBase64URL(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

export function registrationCredentialToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    ...commonCredentialJSON(credential),
    response: {
      clientDataJSON: encodeBase64URL(response.clientDataJSON),
      attestationObject: encodeBase64URL(response.attestationObject),
      transports: response.getTransports?.() ?? [],
    },
  };
}

export function loginCredentialToJSON(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    ...commonCredentialJSON(credential),
    response: {
      clientDataJSON: encodeBase64URL(response.clientDataJSON),
      authenticatorData: encodeBase64URL(response.authenticatorData),
      signature: encodeBase64URL(response.signature),
      userHandle: response.userHandle ? encodeBase64URL(response.userHandle) : null,
    },
  };
}

export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    "PublicKeyCredential" in window &&
    Boolean(navigator.credentials)
  );
}
