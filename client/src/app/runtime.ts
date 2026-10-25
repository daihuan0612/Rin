import { createClient } from "../api/client";
import { endpoint } from "../config";

export { endpoint };

export const client = createClient(endpoint);
