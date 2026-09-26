import { Pool, type PoolClient } from "pg";

/** Every business transaction runs under the non-admin role and one owner. */
export class PivloomDatabase {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 8,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
      statement_timeout: 10_000,
      application_name: "pivloom-api",
    });
    this.pool.on("error", () => { /* A later readiness/request reports the outage without credentials. */ });
  }

  async owned<T>(ownerId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    // transaction_timeout terminates the backend. The pool only handles errors
    // on idle clients, so retain this listener until the borrowed client is released.
    let connectionError: Error | undefined;
    const onConnectionError = (error: Error) => { connectionError = error; };
    client.on('error', onConnectionError);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nano_api");
      await client.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [ownerId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release(connectionError);
      client.removeListener('error', onConnectionError);
    }
  }

  /**
   * Runs a maintenance statement as `nano_api` without impersonating an owner.
   * Only the two SECURITY DEFINER recovery functions are callable this way, so
   * the API process never needs a privileged connection string.
   */
  async system<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE nano_api");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async healthy() {
    try {
      await this.owned("00000000-0000-4000-8000-000000000000", async (client) => {
        await client.query("SELECT id, owner_id, title, current_revision_id, created_at, updated_at FROM nano.projects LIMIT 0");
      });
      return true;
    } catch {
      return false;
    }
  }

  close() { return this.pool.end(); }
}
