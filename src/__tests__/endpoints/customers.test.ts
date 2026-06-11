import express from 'express';
import request from 'supertest';
import customersRouter from '../../routes/customers';

// ── Mock du module Supabase (client par défaut + getUserFromToken) ────────────
// from(table) renvoie un builder chaînable ; single()/maybeSingle() résolvent la
// réponse câblée pour cette table via __setTable, et chaque .eq(col,val) est
// enregistré par table (__eqCalls) pour prouver le scoping. Mocker le module évite
// aussi que le vrai config/supabase throw (env absent) ou accède au réseau.
jest.mock('../../config/supabase', () => {
    const mockResponses: Record<string, { data: any; error: any }> = {};
    const mockEqCalls: Record<string, Array<[string, any]>> = {};
    const makeBuilder = (table: string) => {
        const resolve = () => Promise.resolve(mockResponses[table] ?? { data: null, error: null });
        const builder: any = {};
        ['select', 'update', 'insert', 'delete', 'order', 'range', 'or', 'gte', 'lte', 'match']
            .forEach((m) => { builder[m] = jest.fn(() => builder); });
        builder.eq = jest.fn((col: string, val: any) => {
            (mockEqCalls[table] ||= []).push([col, val]);
            return builder;
        });
        builder.single = jest.fn(resolve);
        builder.maybeSingle = jest.fn(resolve);
        return builder;
    };
    const supabase = {
        from: jest.fn((t: string) => makeBuilder(t)),
        rpc: jest.fn(() => Promise.resolve({ data: 0, error: null })),
    };
    return {
        __esModule: true,
        default: supabase,
        supabase,
        getUserFromToken: jest.fn(),
        // Helpers de test uniquement (absents du module réel)
        __setTable: (t: string, data: any, error: any = null) => { mockResponses[t] = { data, error }; },
        __eqCalls: (t: string) => mockEqCalls[t] || [],
        __reset: () => {
            Object.keys(mockResponses).forEach((k) => delete mockResponses[k]);
            Object.keys(mockEqCalls).forEach((k) => delete mockEqCalls[k]);
        },
    };
});

const supa = jest.requireMock('../../config/supabase') as any;
const supabaseMock = supa.supabase as any;
const getUserFromToken = supa.getUserFromToken as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api', customersRouter); // montage réel (server.ts: app.use('/api', customersRoutes))

const CONFIRMED_USER = {
    id: 'sb-user-A',
    email: 'owner@resto-a.fr',
    email_confirmed_at: '2026-06-01T00:00:00Z',
};
const RESTO_A = { id: 'resto-A', email: 'owner@resto-a.fr' };

// Authentifie l'utilisateur et résout SON restaurant (resto-A) côté middleware.
function authOk() {
    getUserFromToken.mockResolvedValue(CONFIRMED_USER);
    supa.__setTable('restaurants', RESTO_A);
}

beforeEach(() => {
    supa.__reset();
    getUserFromToken.mockReset();
    supabaseMock.rpc.mockClear();
    supabaseMock.rpc.mockResolvedValue({ data: 0, error: null });
});

describe('GET /api/customers — auth + scoping restaurant', () => {
    it('sans token → 401 (validation du token non tentée)', async () => {
        const res = await request(app).get('/api/customers?phone=%2B33600000000');
        expect(res.status).toBe(401);
        expect(getUserFromToken).not.toHaveBeenCalled();
    });

    it('token invalide → 403', async () => {
        getUserFromToken.mockResolvedValue(null);
        const res = await request(app)
            .get('/api/customers?phone=%2B33600000000')
            .set('Authorization', 'Bearer invalid');
        expect(res.status).toBe(403);
    });

    it('scope au restaurant du token et IGNORE le restaurant_id injecté en query', async () => {
        authOk();
        supa.__setTable('customers', {
            id: 'cust-1', restaurant_id: 'resto-A', phone: '+33600000000', name: 'Alice', bookings: [],
        });
        // L'attaquant tente d'injecter resto-B dans la query
        const res = await request(app)
            .get('/api/customers?phone=%2B33600000000&restaurant_id=resto-B')
            .set('Authorization', 'Bearer valid');
        expect(res.status).toBe(200);
        // Preuve du scoping : la requête customers a filtré sur resto-A (token), jamais resto-B (query)
        const eqs = supa.__eqCalls('customers');
        expect(eqs).toContainEqual(['restaurant_id', 'resto-A']);
        expect(eqs).not.toContainEqual(['restaurant_id', 'resto-B']);
        // Aucune donnée d'un autre restaurant dans la réponse
        expect(res.body.restaurant_id).toBe('resto-A');
    });

    it('client inexistant pour ce restaurant → 404', async () => {
        authOk();
        supa.__setTable('customers', null);
        const res = await request(app)
            .get('/api/customers?phone=%2B33699999999')
            .set('Authorization', 'Bearer valid');
        expect(res.status).toBe(404);
    });
});

describe('PATCH /api/customers/:id — auth + scoping restaurant', () => {
    it('sans token → 401', async () => {
        const res = await request(app).patch('/api/customers/cust-1').send({ name: 'X' });
        expect(res.status).toBe(401);
        expect(getUserFromToken).not.toHaveBeenCalled();
    });

    it('token invalide → 403', async () => {
        getUserFromToken.mockResolvedValue(null);
        const res = await request(app)
            .patch('/api/customers/cust-1')
            .set('Authorization', 'Bearer invalid')
            .send({ name: 'X' });
        expect(res.status).toBe(403);
    });

    it('client d\'un AUTRE restaurant → 404 ; l\'update est borné à resto-A', async () => {
        authOk();
        supa.__setTable('customers', null); // update borné resto-A ne matche aucune ligne
        const res = await request(app)
            .patch('/api/customers/cust-of-B')
            .set('Authorization', 'Bearer valid')
            .send({ notes: 'tentative cross-tenant' });
        expect(res.status).toBe(404);
        expect(supa.__eqCalls('customers')).toContainEqual(['restaurant_id', 'resto-A']);
    });

    it('accès légitime → 200 + ligne mise à jour', async () => {
        authOk();
        supa.__setTable('customers', { id: 'cust-1', restaurant_id: 'resto-A', name: 'Nouveau Nom' });
        const res = await request(app)
            .patch('/api/customers/cust-1')
            .set('Authorization', 'Bearer valid')
            .send({ name: 'Nouveau Nom' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: 'cust-1', restaurant_id: 'resto-A', name: 'Nouveau Nom' });
    });

    it('authentifié mais aucun champ modifiable → 400', async () => {
        authOk();
        const res = await request(app)
            .patch('/api/customers/cust-1')
            .set('Authorization', 'Bearer valid')
            .send({ unknown_field: 'ignoré' });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/internal/mark-noshows — protégé par INTERNAL_SECRET (non public)', () => {
    const SECRET = 'test-internal-secret-aaaaaaaaaaaaaaaaaaaa';
    beforeEach(() => { process.env.INTERNAL_SECRET = SECRET; });
    afterEach(() => { delete process.env.INTERNAL_SECRET; });

    it('sans secret → 401', async () => {
        const res = await request(app).post('/api/internal/mark-noshows');
        expect(res.status).toBe(401);
    });

    it('mauvais secret → 401', async () => {
        const res = await request(app)
            .post('/api/internal/mark-noshows')
            .set('x-internal-secret', 'wrong');
        expect(res.status).toBe(401);
    });

    it('secret valide → 200', async () => {
        supabaseMock.rpc.mockResolvedValueOnce({ data: 4, error: null });
        const res = await request(app)
            .post('/api/internal/mark-noshows')
            .set('x-internal-secret', SECRET);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ marked: 4 });
    });
});
