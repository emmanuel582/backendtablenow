import express from 'express';
import request from 'supertest';
import customersRouter from '../../routes/customers';

// ── Mock du module Supabase (client par défaut + getUserFromToken) ────────────
// from(table) renvoie un builder chaînable ; single()/maybeSingle() résolvent la
// réponse câblée pour cette table via __setTable. Comme le vrai config/supabase
// throw si l'env est absent, le mocker évite aussi tout accès réseau/secret.
jest.mock('../../config/supabase', () => {
    const mockResponses: Record<string, { data: any; error: any }> = {};
    const makeBuilder = (table: string) => {
        const resolve = () => Promise.resolve(mockResponses[table] ?? { data: null, error: null });
        const builder: any = {};
        ['select', 'update', 'insert', 'delete', 'eq', 'order', 'range', 'or', 'gte', 'lte', 'match']
            .forEach((m) => { builder[m] = jest.fn(() => builder); });
        builder.single = jest.fn(resolve);
        builder.maybeSingle = jest.fn(resolve);
        return builder;
    };
    const supabase = { from: jest.fn((t: string) => makeBuilder(t)) };
    return {
        __esModule: true,
        default: supabase,
        supabase,
        getUserFromToken: jest.fn(),
        // Helpers de test uniquement (absents du module réel)
        __setTable: (t: string, data: any, error: any = null) => { mockResponses[t] = { data, error }; },
        __reset: () => { Object.keys(mockResponses).forEach((k) => delete mockResponses[k]); },
    };
});

const supa = jest.requireMock('../../config/supabase') as any;
const getUserFromToken = supa.getUserFromToken as jest.Mock;

const app = express();
app.use(express.json());
app.use('/api', customersRouter); // montage réel (server.ts: app.use('/api', customersRoutes))

const CONFIRMED_USER = {
    id: 'sb-user-A',
    email: 'owner@resto-a.fr',
    email_confirmed_at: '2026-06-01T00:00:00Z',
};

beforeEach(() => {
    supa.__reset();
    getUserFromToken.mockReset();
});

describe('PATCH /api/customers/:id — authentification + scoping restaurant', () => {
    it('sans token → 401 (et la validation du token n\'est même pas tentée)', async () => {
        const res = await request(app).patch('/api/customers/cust-1').send({ name: 'Hacker' });
        expect(res.status).toBe(401);
        expect(getUserFromToken).not.toHaveBeenCalled();
    });

    it('token invalide → 403', async () => {
        getUserFromToken.mockResolvedValue(null);
        const res = await request(app)
            .patch('/api/customers/cust-1')
            .set('Authorization', 'Bearer invalid-token')
            .send({ name: 'Hacker' });
        expect(res.status).toBe(403);
    });

    it('client d\'un AUTRE restaurant → 404 (pas d\'écriture cross-tenant, pas de fuite)', async () => {
        getUserFromToken.mockResolvedValue(CONFIRMED_USER);
        // Auth → resout le restaurant de l'utilisateur (resto-A)
        supa.__setTable('restaurants', { id: 'resto-A', email: 'owner@resto-a.fr' });
        // L'update borné à resto-A ne matche aucune ligne (le client appartient à resto-B)
        supa.__setTable('customers', null);
        const res = await request(app)
            .patch('/api/customers/cust-belongs-to-B')
            .set('Authorization', 'Bearer valid-token')
            .send({ notes: 'tentative cross-tenant' });
        expect(res.status).toBe(404);
    });

    it('accès légitime (client du restaurant) → 200 + ligne mise à jour', async () => {
        getUserFromToken.mockResolvedValue(CONFIRMED_USER);
        supa.__setTable('restaurants', { id: 'resto-A', email: 'owner@resto-a.fr' });
        supa.__setTable('customers', { id: 'cust-1', restaurant_id: 'resto-A', name: 'Nouveau Nom' });
        const res = await request(app)
            .patch('/api/customers/cust-1')
            .set('Authorization', 'Bearer valid-token')
            .send({ name: 'Nouveau Nom' });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: 'cust-1', restaurant_id: 'resto-A', name: 'Nouveau Nom' });
    });

    it('authentifié mais aucun champ modifiable → 400', async () => {
        getUserFromToken.mockResolvedValue(CONFIRMED_USER);
        supa.__setTable('restaurants', { id: 'resto-A', email: 'owner@resto-a.fr' });
        const res = await request(app)
            .patch('/api/customers/cust-1')
            .set('Authorization', 'Bearer valid-token')
            .send({ unknown_field: 'ignoré' });
        expect(res.status).toBe(400);
    });
});
