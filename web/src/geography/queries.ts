import type { QueryClient, Query } from "@tanstack/react-query";
const operations = new Set(["getGeography", "getGeographyLocations", "getGeographyUsers"]);
function featureQuery(query: Query): boolean {
  const first=query.queryKey[0];return !!first&&typeof first==="object"&&"_id" in first&&operations.has(String(first._id));
}
export async function invalidateGeography(client: QueryClient): Promise<void> {
  await client.cancelQueries({predicate:featureQuery});
  const rootQuery=(query:Query)=>{const key=query.queryKey[0] as {_id?:string;query?:{snapshot_id?:string}};return key?._id==="getGeography"&&!key.query?.snapshot_id;};
  client.removeQueries({predicate:query=>featureQuery(query)&&!rootQuery(query)});
  await client.resetQueries({predicate:rootQuery});
}
export function removeGeography(client: QueryClient): void {client.removeQueries({predicate:query=>featureQuery(query)||(query.queryKey[0] as {_id?:string})?._id==="getGeographySettings"});}

export function geographyErrorCode(error: unknown): string | null {
  if(error&&typeof error==="object"&&"code" in error&&typeof error.code==="string")return error.code;
  return null;
}
