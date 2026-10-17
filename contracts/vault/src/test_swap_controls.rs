//! Regression tests for swap and subscription controls (#1925, #1926, #1927, #1928).

use crate::errors::VaultError;
use crate::types::{
    Condition, ConditionLogic, DexConfig, InsuranceConfig, Priority, ProposalStatus, RetryConfig,
    Role, StakingConfig, SubscriptionTier, SwapProposal, ThresholdStrategy, VelocityConfig,
    VoteWeight,
};
use crate::{InitConfig, VaultDAO, VaultDAOClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, Symbol, Vec,
};

struct Ctx<'a> {
    client: VaultDAOClient<'a>,
    contract_id: Address,
    admin: Address,
    treasurer: Address,
    dex: Address,
}

fn setup(env: &Env) -> Ctx<'_> {
    env.mock_all_auths();

    let contract_id = env.register(VaultDAO, ());
    let client = VaultDAOClient::new(env, &contract_id);
    let admin = Address::generate(env);
    let treasurer = Address::generate(env);
    let dex = Address::generate(env);

    let mut signers = Vec::new(env);
    signers.push_back(admin.clone());
    signers.push_back(treasurer.clone());

    client.initialize(
        &admin,
        &InitConfig {
            veto_window_ledgers: 0,
            whitelist_mode: false,
            grace_period_ledgers: 100,
            vote_weight: VoteWeight::Flat,
            high_impact_threshold: 70,
            admin_rotation_delay: 1440,
            signers,
            threshold: 2,
            quorum: 0,
            default_voting_deadline: 0,
            spending_limit: 10_000,
            daily_limit: 50_000,
            weekly_limit: 100_000,
            timelock_threshold: 5_000,
            timelock_delay: 100,
            velocity_limit: VelocityConfig {
                limit: 100,
                window: 3600,
                per_token_limit: 0,
            },
            threshold_strategy: ThresholdStrategy::Fixed,
            pre_execution_hooks: Vec::new(env),
            post_execution_hooks: Vec::new(env),
            veto_addresses: Vec::new(env),
            retry_config: RetryConfig {
                max_retry_delay: 0,
                enabled: false,
                max_retries: 0,
                initial_backoff_ledgers: 0,
            },
            recovery_config: crate::types::RecoveryConfig::default(env),
            staking_config: StakingConfig::default(),
            proposal_id_prefix: 0,
            quorum_percentage: 0,
        },
    );
    client.set_role(&admin, &treasurer, &Role::Treasurer);

    let mut enabled_dexs = Vec::new(env);
    enabled_dexs.push_back(dex.clone());
    client.set_dex_config(
        &admin,
        &DexConfig {
            enabled_dexs,
            max_slippage_bps: 100,
            max_price_impact_bps: 500,
            min_liquidity: 1000,
        },
    );

    Ctx {
        client,
        contract_id,
        admin,
        treasurer,
        dex,
    }
}

fn swap_op(ctx: &Ctx, token_in: &Address, token_out: &Address, amount: i128) -> SwapProposal {
    SwapProposal::Swap(
        ctx.dex.clone(),
        token_in.clone(),
        token_out.clone(),
        amount,
        0,
    )
}

// ============================================================================
// #1925: subscriptions only accept supported tokens
// ============================================================================

#[test]
fn test_subscription_rejects_unsupported_token() {
    let env = Env::default();
    let ctx = setup(&env);
    let subscriber = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token).mint(&subscriber, &1000);

    let res = ctx.client.try_create_subscription(
        &subscriber,
        &provider,
        &SubscriptionTier::Basic,
        &token,
        &100i128,
        &1000u64,
        &false,
        &0u64,
    );
    assert_eq!(res, Err(Ok(VaultError::TokenNotSupported)));
    assert_eq!(TokenClient::new(&env, &token).balance(&subscriber), 1000);
}

#[test]
fn test_subscription_first_payment_goes_straight_to_provider() {
    let env = Env::default();
    let ctx = setup(&env);
    let subscriber = Address::generate(&env);
    let provider = Address::generate(&env);
    let token = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();
    StellarAssetClient::new(&env, &token).mint(&subscriber, &1000);
    ctx.client.add_supported_token(&ctx.admin, &token, &10_000, &100_000);

    ctx.client.create_subscription(
        &subscriber,
        &provider,
        &SubscriptionTier::Basic,
        &token,
        &100i128,
        &1000u64,
        &false,
        &0u64,
    );

    let token_client = TokenClient::new(&env, &token);
    assert_eq!(token_client.balance(&provider), 100);
    assert_eq!(token_client.balance(&subscriber), 900);
    assert_eq!(token_client.balance(&ctx.contract_id), 0);
}

