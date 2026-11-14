import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

interface RmqTlsFiles {
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
}

/** Nest / amqp-connection-manager socketOptions shape. */
export interface RmqSocketOptions {
  heartbeatIntervalInSeconds: number;
  reconnectTimeInSeconds: number;
  connectionOptions?: {
    ca: Buffer[];
    cert: Buffer;
    key: Buffer;
    rejectUnauthorized: boolean;
    servername?: string;
  };
}

/** When RABBITMQ_TLS_DIR is set, load mutual-TLS materials for amqps. */
function loadRmqTlsFiles(dir = process.env.RABBITMQ_TLS_DIR): RmqTlsFiles | null {
  if (!dir) return null;
  const caPath = join(dir, 'ca.pem');
  const certPath = join(dir, 'client.pem');
  const keyPath = join(dir, 'client-key.pem');
  if (!existsSync(caPath) || !existsSync(certPath) || !existsSync(keyPath)) {
    throw new Error(`RABBITMQ_TLS_DIR=${dir} incomplete (need ca.pem, client.pem, client-key.pem)`);
  }
  return {
    ca: readFileSync(caPath),
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
}

/** Normalize broker URL to amqps://…:5671 when TLS materials are present. */
function resolveRmqUrl(raw: string, tlsEnabled: boolean): string {
  if (!tlsEnabled) return raw;
  let url = raw.trim();
  if (url.startsWith('amqp://')) {
    url = `amqps://${url.slice('amqp://'.length)}`;
  }
  // Swap cleartext AMQP port for TLS listener when left at default.
  url = url.replace(/:5672(\/|$)/, ':5671$1');
  return url;
}

/**
 * Socket options for Nest Transport.RMQ and amqp-connection-manager.
 * TLS materials nest under `connectionOptions` (Nest ServerRMQ reads that key).
 */
function rmqSocketOptions(extra?: Record<string, unknown>): RmqSocketOptions {
  const tls = loadRmqTlsFiles();
  const base: RmqSocketOptions = {
    heartbeatIntervalInSeconds: 15,
    reconnectTimeInSeconds: 5,
  };
  if (extra) {
    Object.assign(base, extra);
  }
  if (!tls) return base;
  return {
    ...base,
    connectionOptions: {
      ca: [tls.ca],
      cert: tls.cert,
      key: tls.key,
      rejectUnauthorized: true,
      // Match SAN CN=rabbitmq / DNS:rabbitmq
      servername: 'rabbitmq',
    },
  };
}

/** Flat TLS connect opts for raw `amqplib.connect(url, opts)`. */
export function rmqAmqpConnectOptions(
  socketOptions: RmqSocketOptions = rmqSocketOptions(),
): RmqSocketOptions['connectionOptions'] | undefined {
  return socketOptions.connectionOptions;
}

export function rmqConnectionOptions(): { url: string; socketOptions: RmqSocketOptions } {
  const raw = process.env.RABBITMQ_URL ?? 'amqp://anonyma:anonyma@localhost:5672';
  const tls = loadRmqTlsFiles();
  return {
    url: resolveRmqUrl(raw, Boolean(tls)),
    socketOptions: rmqSocketOptions(),
  };
}
