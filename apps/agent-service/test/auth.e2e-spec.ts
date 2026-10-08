import { createHash } from 'node:crypto';
import request from 'supertest';
import { bootService, type ServiceApp } from './service-app.js';

const TOKEN = 'service-spec-token';
const digest = (token: string) => createHash('sha256').update(token).digest('hex');

const RUN_BODY = {
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  messages: [{ role: 'user', content: 'What is LangGraph?' }],
};

/** Every covered route, with a body that would otherwise be served. */
const COVERED = [
  { path: '/runs', body: RUN_BODY, served: 200 },
  { path: '/runs/stream', body: RUN_BODY, served: 200 },
  {
    path: '/a2a/jsonrpc',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'SendMessage',
      params: { message: { messageId: 'auth-1', role: 'ROLE_USER', parts: [{ text: 'Hi' }] } },
    },
    served: 200,
  },
] as const;

describe('Service authentication, enforced', () => {
  let service: ServiceApp;

  beforeAll(async () => {
    service = await bootService({ SERVICE_CREDENTIALS: `spec:${digest(TOKEN)}` });
  });

  afterAll(async () => {
    await service.close();
  });

  describe.each(COVERED)('POST $path', ({ path, body, served }) => {
    it('answers 401 with a Bearer challenge to a missing token', async () => {
      const response = await request(service.app.getHttpServer()).post(path).send(body);

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="agent-service"');
    });

    it('answers 401 with a Bearer challenge to a wrong token', async () => {
      const response = await request(service.app.getHttpServer())
        .post(path)
        .set('Authorization', 'Bearer not-the-token')
        .send(body);

      expect(response.status).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer realm="agent-service"');
    });

    it('serves the request with the token', async () => {
      const response = await request(service.app.getHttpServer())
        .post(path)
        .set('A2A-Version', '1.0')
        .set('Authorization', `Bearer ${TOKEN}`)
        .send(body);

      expect(response.status).toBe(served);
      expect(response.body?.error).toBeUndefined();
    }, 20_000);
  });

  it('covers a route nobody named, because the rule is deny by default', async () => {
    const response = await request(service.app.getHttpServer()).get('/no-such-route');

    expect(response.status).toBe(401);
  });

  // Amended at P3-E's review: the FHIR intake (P3-D) and the clinician review
  // queue (P3-E) are covered too. Neither is named in the middleware.
  it.each([
    ['POST', '/fhir/Claim/$submit'],
    ['POST', '/fhir/Claim/$inquire'],
    ['GET', '/fhir/metadata'],
    ['GET', '/review/cases'],
    ['GET', '/review/cases/any'],
    ['POST', '/review/cases/any/determination'],
  ])('answers 401 to %s %s with no token', async (method, path) => {
    const server = request(service.app.getHttpServer());
    const response = await (method === 'GET' ? server.get(path) : server.post(path).send({}));

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer realm="agent-service"');
  });

  it.each(['/health', '/.well-known/agent-card.json', '/.well-known/jwks.json'])(
    'serves GET %s with no token',
    async (path) => {
      const response = await request(service.app.getHttpServer()).get(path);

      expect(response.status).toBe(200);
    },
  );

  it('gives a cross-origin preflight no Access-Control-Allow-Origin', async () => {
    const response = await request(service.app.getHttpServer())
      .options('/runs')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('Service authentication, open', () => {
  let service: ServiceApp;

  beforeAll(async () => {
    service = await bootService();
  });

  afterAll(async () => {
    await service.close();
  });

  it('serves POST /runs with no token', async () => {
    const response = await request(service.app.getHttpServer()).post('/runs').send(RUN_BODY);

    expect(response.status).toBe(200);
  });

  it('gives a cross-origin preflight no Access-Control-Allow-Origin when open', async () => {
    const response = await request(service.app.getHttpServer())
      .options('/runs')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
