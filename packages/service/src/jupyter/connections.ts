import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  JupyterCoordinatorClient,
  DatalayerJupyterClient,
  createJupyterCookieJar,
  type JupyterCoordinatorOptions,
  type JupyterConnectionInspection,
  type DatalayerConnectionInspection,
} from '@disclaude/core';

export interface JupyterConnectionDefinition {
  id: string;
  /** Omitted selects Datalayer. The historical coordinator must be explicit. */
  backend?: 'coordinator' | 'datalayer';
  baseUrl: string;
  authorizationEnv?: string;
  authorizationFile?: string;
  passwordEnv?: string;
  passwordFile?: string;
  allowInsecureHttp?: boolean;
}

export type JupyterBackendInspection =
  | DatalayerConnectionInspection
  | (JupyterConnectionInspection & { backend: 'coordinator' });

type Jar = NonNullable<JupyterCoordinatorOptions['cookieJar']>;
interface Connection<T = JupyterCoordinatorClient> {
  client: T;
  jar: Jar;
  cookiePath: string;
}

/** Host configuration and cookie state live outside Project references and tool DTOs. */
export class JupyterConnections {
  private readonly clients = new Map<string, Promise<Connection>>();
  private readonly datalayerClients = new Map<
    string,
    Promise<Connection<DatalayerJupyterClient>>
  >();

  constructor(
    readonly configPath: string,
    private readonly environment: () => Record<string, string | undefined>
  ) {}

  private definitions(): JupyterConnectionDefinition[] {
    const stat = fs.lstatSync(this.configPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536 || (stat.mode & 0o077) !== 0) {
      throw new Error('Jupyter host configuration must be a private regular file');
    }
    const config = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) as {
      version?: unknown;
      connections?: unknown;
    };
    if (
      config.version !== 1 ||
      !Array.isArray(config.connections) ||
      config.connections.length > 16
    ) {
      throw new Error('Invalid Jupyter host connection configuration');
    }
    const ids = new Set<string>();
    return config.connections.map((value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Invalid Jupyter connection');
      }
      const d = value as Record<string, unknown>;
      const references = ['authorizationEnv', 'authorizationFile', 'passwordEnv', 'passwordFile'];
      if (
        typeof d.id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(d.id) ||
        ids.has(d.id) ||
        typeof d.baseUrl !== 'string' ||
        (d.backend !== undefined && d.backend !== 'coordinator' && d.backend !== 'datalayer') ||
        references.filter((key) => typeof d[key] === 'string').length !== 1 ||
        references.some((key) => d[key] !== undefined && (typeof d[key] !== 'string' || !d[key])) ||
        ['authorizationEnv', 'passwordEnv'].some(
          (key) => typeof d[key] === 'string' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(d[key])
        ) ||
        (d.allowInsecureHttp !== undefined && typeof d.allowInsecureHttp !== 'boolean')
      ) {
        throw new Error('Invalid Jupyter host connection identity or authentication reference');
      }
      ids.add(d.id);
      return {
        id: d.id,
        baseUrl: d.baseUrl,
        backend: d.backend === 'coordinator' ? 'coordinator' : 'datalayer',
        ...(typeof d.authorizationEnv === 'string' ? { authorizationEnv: d.authorizationEnv } : {}),
        ...(typeof d.authorizationFile === 'string'
          ? { authorizationFile: d.authorizationFile }
          : {}),
        ...(typeof d.passwordEnv === 'string' ? { passwordEnv: d.passwordEnv } : {}),
        ...(typeof d.passwordFile === 'string' ? { passwordFile: d.passwordFile } : {}),
        ...(d.allowInsecureHttp === true ? { allowInsecureHttp: true } : {}),
      };
    });
  }

  private authentication(definition: JupyterConnectionDefinition): string {
    let value: string | undefined;
    const envReference = definition.authorizationEnv ?? definition.passwordEnv;
    const fileReference = definition.authorizationFile ?? definition.passwordFile;
    if (envReference) {
      value = this.environment()[envReference];
    }
    if (fileReference) {
      const stat = fs.lstatSync(fileReference);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8192 ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error('Jupyter authentication reference cannot be verified');
      }
      const raw = fs.readFileSync(fileReference, 'utf8');
      value = definition.passwordFile ? raw : raw.trim();
    }
    if (!value || value.length > 8192 || /[\r\n]/.test(value)) {
      throw new Error('Jupyter authentication is unavailable');
    }
    return value;
  }

  private async prepareConnection(
    definition: JupyterConnectionDefinition,
    namespace: string
  ): Promise<Connection> {
    if (definition.backend === 'datalayer') {
      throw new Error('Notebook requires the Datalayer client');
    }
    return await this.prepare(
      definition,
      namespace,
      (options) => new JupyterCoordinatorClient(options)
    );
  }

  backend(connectionId: string): 'coordinator' | 'datalayer' {
    const definition = this.definitions().find((d) => d.id === connectionId);
    if (!definition) {
      throw new Error('Notebook connection is not authorized by the host');
    }
    return definition.backend ?? 'datalayer';
  }

  private async prepare<T>(
    definition: JupyterConnectionDefinition,
    namespace: string,
    create: (options: JupyterCoordinatorOptions) => T
  ): Promise<Connection<T>> {
    // Historical coordinator definitions omitted this field from cookie identity.
    // Preserve their authenticated jars when the operator makes the backend explicit.
    const cookieDefinition = { ...definition };
    if (cookieDefinition.backend === 'coordinator') {
      delete cookieDefinition.backend;
    }
    const key = createHash('sha256')
      .update(JSON.stringify([cookieDefinition, namespace]))
      .digest('hex');
    const cookiePath = join(dirname(this.configPath), 'sessions', `${key}.json`);
    let saved: unknown;
    try {
      const stat = fs.lstatSync(cookiePath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 262144 ||
        (stat.mode & 0o077) !== 0
      ) {
        throw new Error('Jupyter host cookie state cannot be verified');
      }
      saved = JSON.parse(fs.readFileSync(cookiePath, 'utf8')) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    const jar = await createJupyterCookieJar(saved);
    const client = create({
      baseUrl: definition.baseUrl,
      connectionId: definition.id,
      ...(namespace ? { serverNamespace: namespace } : {}),
      ...(definition.passwordEnv || definition.passwordFile
        ? { password: () => Promise.resolve(this.authentication(definition)) }
        : { authorization: () => Promise.resolve(this.authentication(definition)) }),
      allowInsecureHttp: definition.allowInsecureHttp,
      cookieJar: jar,
    });
    return { client, jar, cookiePath };
  }

  private async connect(
    definition: JupyterConnectionDefinition,
    namespace: string
  ): Promise<Connection> {
    const connection = await this.prepareConnection(definition, namespace);
    try {
      await connection.client.connect();
      return connection;
    } finally {
      await this.persist(connection);
    }
  }

  /** Safe host discovery. No Project, controller, document or kernel changes. */
  async inspect(connectionId: string, namespace = ''): Promise<JupyterBackendInspection> {
    const definition = this.definitions().find((item) => item.id === connectionId);
    if (!definition) {
      throw new Error('Notebook connection is not authorized by the host');
    }
    if (definition.backend === 'datalayer') {
      const connection = await this.prepare(
        definition,
        namespace,
        (options) => new DatalayerJupyterClient(options)
      );
      try {
        return await connection.client.inspectConnection();
      } finally {
        await this.persist(connection);
      }
    }
    const connection = await this.prepareConnection(definition, namespace);
    try {
      return { backend: 'coordinator', ...(await connection.client.inspectConnection()) };
    } finally {
      await this.persist(connection);
    }
  }

  private async persist(connection: Connection<unknown>): Promise<void> {
    const data = `${JSON.stringify(await connection.jar.serialize())}\n`;
    if (Buffer.byteLength(data) > 262144) {
      throw new Error('Jupyter host cookie state limit exceeded');
    }
    fs.mkdirSync(dirname(connection.cookiePath), { recursive: true, mode: 0o700 });
    const directoryState = fs.lstatSync(dirname(connection.cookiePath));
    if (
      !directoryState.isDirectory() ||
      directoryState.isSymbolicLink() ||
      (directoryState.mode & 0o077) !== 0
    ) {
      throw new Error('Jupyter host cookie directory cannot be verified');
    }
    const temp = `${connection.cookiePath}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, connection.cookiePath);
    } finally {
      if (created) {
        try {
          fs.unlinkSync(temp);
        } catch {
          /* Successful rename removed it. */
        }
      }
    }
  }

  async useDatalayer<T>(
    connectionId: string,
    namespace: string,
    operation: (client: DatalayerJupyterClient) => Promise<T>
  ): Promise<T> {
    const definition = this.definitions().find((d) => d.id === connectionId);
    if (!definition || definition.backend !== 'datalayer') {
      throw new Error('Datalayer Notebook connection is not authorized by the host');
    }
    const key = JSON.stringify([definition, namespace]);
    let pending = this.datalayerClients.get(key);
    if (!pending) {
      if (this.datalayerClients.size >= 32) {
        throw new Error('Jupyter host session limit exceeded');
      }
      pending = (async () => {
        const connection = await this.prepare(
          definition,
          namespace,
          (options) => new DatalayerJupyterClient(options)
        );
        try {
          await connection.client.initialize();
          return connection;
        } finally {
          await this.persist(connection);
        }
      })();
      this.datalayerClients.set(key, pending);
    }
    let connection: Connection<DatalayerJupyterClient>;
    try {
      connection = await pending;
    } catch (error) {
      this.datalayerClients.delete(key);
      throw error;
    }
    try {
      return await operation(connection.client);
    } finally {
      await this.persist(connection);
    }
  }

  async use<T>(
    connectionId: string,
    namespace: string,
    operation: (client: JupyterCoordinatorClient) => Promise<T>
  ): Promise<T> {
    const definition = this.definitions().find((item) => item.id === connectionId);
    if (!definition) {
      throw new Error('Notebook connection is not authorized by the host');
    }
    const key = JSON.stringify([definition, namespace]);
    let pending = this.clients.get(key);
    if (!pending) {
      if (this.clients.size >= 32) {
        throw new Error('Jupyter host session limit exceeded');
      }
      pending = this.connect(definition, namespace);
      this.clients.set(key, pending);
    }
    let connection: Connection;
    try {
      connection = await pending;
    } catch (error) {
      if (this.clients.get(key) === pending) {
        this.clients.delete(key);
      }
      throw error;
    }
    try {
      return await operation(connection.client);
    } finally {
      await this.persist(connection);
    }
  }

  /** Remove connection secrets from the environment passed to model processes. */
  redactEnvironment(environment: Record<string, string | undefined>): void {
    for (const definition of this.definitions()) {
      if (definition.authorizationEnv) {
        // An explicit undefined overrides inherited/provider environment too.
        environment[definition.authorizationEnv] = undefined;
      }
      if (definition.passwordEnv) {
        environment[definition.passwordEnv] = undefined;
      }
    }
  }
}
