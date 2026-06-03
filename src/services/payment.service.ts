import * as crypto from 'crypto';
import { config } from '../config';
import { PlanService, PlanTier } from './plan.service';

// -----------------------------------------------------------------------
// LemonSqueezy API types (subset of what we need)
// -----------------------------------------------------------------------

interface LsCheckoutAttributes {
    url: string;
    expires_at: string | null;
}

interface LsCheckoutResponse {
    data: {
        id: string;
        attributes: LsCheckoutAttributes;
    };
}

interface LsWebhookMeta {
    event_name: string;
    custom_data?: {
        user_id?: string;
        tier?: string;
    };
}

interface LsOrderAttributes {
    status: string;        // 'paid' | 'pending' | 'refunded' | 'partial_refund' | 'fraudulent'
    total: number;
    user_email: string;
    identifier: string;   // LS order number
}

export interface LsWebhookPayload {
    meta: LsWebhookMeta;
    data: {
        id: string;
        type: string;
        attributes: LsOrderAttributes;
    };
}

// -----------------------------------------------------------------------
// PaymentService
// -----------------------------------------------------------------------

export class PaymentService {
    private planService: PlanService;
    private baseUrl = 'https://api.lemonsqueezy.com/v1';

    constructor(planService: PlanService) {
        this.planService = planService;
    }

    /**
     * Generate a unique LemonSqueezy checkout link for the user.
     * Passes user_id + tier as custom_data so the webhook can identify the buyer.
     */
    async createCheckoutLink(userId: number, tier: 'pro' | 'premium'): Promise<string | null> {
        if (!config.lsApiKey || !config.lsStoreId) {
            console.error('LemonSqueezy API key or Store ID not configured.');
            return null;
        }

        const variantId = tier === 'pro' ? config.lsProVariantId : config.lsPremiumVariantId;
        if (!variantId) {
            console.error(`LemonSqueezy variant ID for "${tier}" not configured.`);
            return null;
        }

        try {
            const body = {
                data: {
                    type: 'checkouts',
                    attributes: {
                        checkout_data: {
                            custom: {
                                user_id: String(userId),
                                tier,
                            },
                        },
                        // Checkout expires in 30 minutes
                        expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
                    },
                    relationships: {
                        store: {
                            data: { type: 'stores', id: String(config.lsStoreId) },
                        },
                        variant: {
                            data: { type: 'variants', id: String(variantId) },
                        },
                    },
                },
            };

            const res = await fetch(`${this.baseUrl}/checkouts`, {
                method: 'POST',
                headers: {
                    Accept: 'application/vnd.api+json',
                    'Content-Type': 'application/vnd.api+json',
                    Authorization: `Bearer ${config.lsApiKey}`,
                },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const errText = await res.text();
                console.error(`LemonSqueezy checkout error ${res.status}:`, errText);
                return null;
            }

            const json = (await res.json()) as LsCheckoutResponse;
            return json.data.attributes.url;
        } catch (error) {
            console.error('Error creating LemonSqueezy checkout:', error);
            return null;
        }
    }

    /**
     * Verify the HMAC-SHA256 signature sent by LemonSqueezy.
     * Must be called with the raw (unparsed) request body.
     */
    verifyWebhookSignature(rawBody: Buffer, signature: string): boolean {
        if (!config.lsWebhookSecret) {
            console.warn('LEMONSQUEEZY_WEBHOOK_SECRET not set — skipping signature verification.');
            return false;
        }

        try {
            const hmac = crypto.createHmac('sha256', config.lsWebhookSecret);
            const digest = Buffer.from(hmac.update(rawBody).digest('hex'), 'utf8');
            const sigBuffer = Buffer.from(signature, 'utf8');

            if (digest.length !== sigBuffer.length) return false;
            return crypto.timingSafeEqual(digest, sigBuffer);
        } catch {
            return false;
        }
    }

    /**
     * Process an incoming webhook event.
     * Returns the upgraded userId + tier if a plan was changed, null otherwise.
     */
    async handleWebhookEvent(payload: LsWebhookPayload): Promise<{ userId: number; tier: PlanTier } | null> {
        const { event_name, custom_data } = payload.meta;

        if (event_name !== 'order_created') {
            // We only care about successful orders
            return null;
        }

        if (payload.data.attributes.status !== 'paid') {
            console.log(`Webhook: order ${payload.data.id} status = ${payload.data.attributes.status}, skipping.`);
            return null;
        }

        const userId = custom_data?.user_id ? parseInt(custom_data.user_id, 10) : null;
        const tier = custom_data?.tier as PlanTier | undefined;
        const orderId = payload.data.id;

        if (!userId || isNaN(userId)) {
            console.error('Webhook: missing or invalid user_id in custom_data:', custom_data);
            return null;
        }

        if (tier !== 'pro' && tier !== 'premium') {
            console.error('Webhook: invalid tier in custom_data:', tier);
            return null;
        }

        // Idempotency check — skip if this order was already processed
        const currentPlan = await this.planService.getPlan(userId);
        if (currentPlan.lsOrderId === orderId) {
            console.log(`Webhook: order ${orderId} already processed for user ${userId}, skipping.`);
            return null;
        }

        // Upgrade the plan for 30 days
        await this.planService.upgradePlan(userId, tier, 30, orderId);
        console.log(`✅ Upgraded user ${userId} to ${tier} (order ${orderId})`);

        return { userId, tier };
    }
}
