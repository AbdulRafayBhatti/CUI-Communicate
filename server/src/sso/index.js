// Assembles the SSO provider router: the OIDC endpoints plus the administrative dashboard.
import { Router } from 'express';
import providerRoutes from './routes.js';
import adminRoutes from './admin.js';
import { ensureSigningKey } from './security.js';

const router = Router();
router.use(providerRoutes);
router.use('/admin', adminRoutes);

/** Generates/loads the RS256 signing key. Called after the database connection is established. */
export const initSso = () => ensureSigningKey();

export default router;
