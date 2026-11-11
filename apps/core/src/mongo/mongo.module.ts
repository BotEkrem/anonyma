import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Db, MongoClient } from 'mongodb';
import { MESSAGE_TTL_SECONDS } from '@anonyma/shared';

export const MONGO_DB = Symbol('MONGO_DB');
export const MONGO_CLIENT = Symbol('MONGO_CLIENT');

@Global()
@Module({
  providers: [
    {
      provide: MONGO_CLIENT,
      inject: [ConfigService],
      useFactory: async (config: ConfigService): Promise<MongoClient> => {
        const client = new MongoClient(config.getOrThrow<string>('MONGO_URI'));
        await client.connect();
        return client;
      },
    },
    {
      provide: MONGO_DB,
      inject: [MONGO_CLIENT, ConfigService],
      useFactory: async (client: MongoClient, config: ConfigService): Promise<Db> => {
        const uri = config.getOrThrow<string>('MONGO_URI');
        let dbName = 'anonyma';
        try {
          const parsed = new URL(uri);
          const raw = parsed.pathname.replace(/^\//, '');
          if (raw) {
            dbName = raw.split('?')[0] || 'anonyma';
          }
        } catch {
          dbName = config.get<string>('MONGO_DB') ?? 'anonyma';
        }
        const db = client.db(dbName);
        const messages = db.collection('messages');
        await messages.createIndex({ t: 1 }, { expireAfterSeconds: 0 });
        await messages.createIndex({ r: 1, t: -1 });
        // TTL index expireAfterSeconds:0 deletes when `t` date is reached.
        // Application still stamps `t` = now + MESSAGE_TTL_SECONDS.
        void MESSAGE_TTL_SECONDS;
        return db;
      },
    },
  ],
  exports: [MONGO_DB, MONGO_CLIENT],
})
export class MongoModule implements OnModuleDestroy {
  constructor() {}

  // Nest DI for destroy is wired via provider token in AppModule if needed.
  async onModuleDestroy(): Promise<void> {
    // no-op; client closed via dedicated provider lifecycle if registered
  }
}
