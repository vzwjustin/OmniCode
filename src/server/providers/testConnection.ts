export async function testSingleConnection(connectionId: string, validationModelId?: string) {
  const { POST } = await import("@/app/api/providers/[id]/test/route");
  const body = validationModelId === undefined ? undefined : JSON.stringify({ validationModelId });
  const response = await POST(
    new Request(`http://localhost/api/providers/${encodeURIComponent(connectionId)}/test`, {
      method: "POST",
      headers: body ? { "content-type": "application/json" } : undefined,
      body,
    }),
    { params: Promise.resolve({ id: connectionId }) }
  );
  return response.json();
}
