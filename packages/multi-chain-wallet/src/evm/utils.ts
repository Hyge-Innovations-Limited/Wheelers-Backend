import { Balance, TokenInfo } from '../types'
import { JsonRpcProvider, Contract, Wallet, TransactionRequest, TransactionResponse, TransactionReceipt, parseUnits, formatUnits } from 'ethers'
import BN from 'bn.js'

const KYBER_BASE_URL = 'https://aggregator-api.kyberswap.com';

export interface TransactionParams {
    to: string
    value?: string | bigint  // For native token transfers
    data?: string           // For contract calls
    gasLimit?: string | bigint
    gasPrice?: string | bigint
    maxFeePerGas?: string | bigint     // For EIP-1559
    maxPriorityFeePerGas?: string | bigint // For EIP-1559
    nonce?: number
}

interface TransactionResult {
    hash: string
    receipt: TransactionReceipt | null
    success: boolean
    gasUsed?: bigint
    effectiveGasPrice?: bigint
    blockNumber?: number
    confirmations: number
    
}

export interface SwapParams {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    slippageTolerance?: number;
    recipient?: string;
    deadline?: number;
    feeAmount?: string;
    feeReceiver?: string;
    isInBps?: boolean;
    chargeFeeBy?: 'currency_in' | 'currency_out';
}

export interface KyberRoute {
    tokenIn: string;
    amountIn: string;
    tokenOut: string;
    amountOut: string;
    gas: string;
    gasPrice: string;
    gasUsd: number;
    amountOutUsd: string;
    receivedUsd: string;
    swaps: Array<{
        pool: string;
        tokenIn: string;
        tokenOut: string;
        swapAmount: string;
        amountOut: string;
        limitReturnAmount: string;
        maxPrice: string;
        exchange: string;
        poolLength: number;
        poolType: string;
    }>;
    tokens: {
        [address: string]: {
            address: string;
            symbol: string;
            name: string;
            decimals: number;
            price: number;
        };
    };
}

export interface KyberSwapResponse {
    code: number;
    message: string;
    data: {
        routeSummary: KyberRoute;
        routerAddress: string;
    };
}

export interface KyberBuildResponse {
    code: number;
    message: string;
    data: {
        amountIn: string;
        amountInUsd: string;
        amountOut: string;
        amountOutUsd: string;
        gas: string;
        gasUsd: string;
        outputChange: {
            amount: string;
            percent: number;
            level: number;
        };
        data: string;
        routerAddress: string;
    };
}

const KYBER_SUPPORTED_CHAINS: { [key: string]: string } = {
    '1': 'ethereum',
    '56': 'bsc',
    '137': 'polygon',
    '42161': 'arbitrum',
    '10': 'optimism',
    '43114': 'avalanche',
    '8453': 'base',
    '59144': 'linea',
    '5000': 'mantle',
    '146': 'sonic',
    '80094': 'berachain',
    '2020': 'ronin',
    '130': 'unichain',
    '999': 'hyperevm',
    '9745': 'plasma',
    '42793': 'etherlink',
    '143': 'monad',
    '4326': 'megaeth',
    // Added per request
    '1776': 'injective',
    // Legacy/older Kyber mappings retained
    '250': 'fantom',
    '324': 'zksync'
};

export const DESERIALIZED_SUPPORTED_CHAINS: { [key: string]: string } = {
    '16661': '0gMainnet',
};

interface KyberSwapParams {
    chainId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    slippageTolerance?: number; // in bips (e.g., 50 = 0.5%)
    recipient?: string;
    sender?: string;
    deadline?: number; // Unix timestamp
    feeAmount?: string;
    feeReceiver?: string;
    isInBps?: boolean;
    chargeFeeBy?: 'currency_in' | 'currency_out';
    clientId?: string;
}

// ERC-20 ABI
const ERC20_ABI = [
    "function balanceOf(address owner) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function transferFrom(address from, address to, uint256 amount) returns (bool)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function allowance(address owner, address spender) view returns (uint256)"
]

export const getNativeBalance = async (address: string, provider: JsonRpcProvider): Promise<Balance> => {
    const balance = await provider.getBalance(address)

    return {
        balance: new BN(balance),
        formatted: Number(balance / 10n ** 18n),
        decimal: 18
    }
}

export const getTokenInfo = async (
    tokenAddress: string,
    provider: JsonRpcProvider
): Promise<TokenInfo> => {
    try {
        // Create contract instance
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider)


        // Get decimals to format the balance properly
        const [decimals, name, symbol] = await Promise.all([
            await tokenContract.decimals(),
            await tokenContract.name(),
            await tokenContract.symbol(),

        ])

        return {
            name: name,
            symbol: symbol,
            address: tokenAddress,
            decimals: decimals
        }
    } catch (error) {
        console.error('Error fetching token balance:', error)
        throw error
    }
}
export const getTokenBalance = async (
    tokenAddress: string,
    walletAddress: string,
    provider: JsonRpcProvider
): Promise<Balance> => {
    try {
        // Create contract instance
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider)

        // Get balance (returns BigNumber)
        const balance: bigint = await tokenContract.balanceOf(walletAddress)

        // Get decimals to format the balance properly
        const decimals = await tokenContract.decimals()
        // Format balance by dividing by 10^decimals
        const formattedBalance = balance / (10n ** BigInt(decimals))

        return {
            balance: new BN(balance.toString()), // Raw balance as BigNumber
            formatted: Number(formattedBalance.toString()),
            decimal: decimals
        }
    } catch (error) {
        console.error('Error fetching token balance:', error)
        throw error
    }
}

/**
 * Sign, send, and confirm any EVM transaction
 */
export const signSendAndConfirm = async (
    wallet: Wallet, // Connected wallet (private key + provider)
    transactionParams: TransactionParams,
    confirmations: number = 1, // Number of confirmations to wait for
    timeout: number = 300000 // 5 minutes timeout
): Promise<TransactionResult> => {
    try {
        // Prepare transaction object
        const tx: TransactionRequest = {
            to: transactionParams.to,
            value: transactionParams.value || 0,
            data: transactionParams.data || '0x',
        }

        // Set gas parameters
        if (transactionParams.gasLimit) {
            tx.gasLimit = transactionParams.gasLimit
        }

        // Handle gas pricing (EIP-1559 vs legacy)
        if (transactionParams.maxFeePerGas && transactionParams.maxPriorityFeePerGas) {
            // EIP-1559 transaction
            tx.maxFeePerGas = transactionParams.maxFeePerGas
            tx.maxPriorityFeePerGas = transactionParams.maxPriorityFeePerGas
        } else if (transactionParams.gasPrice) {
            // Legacy transaction
            tx.gasPrice = transactionParams.gasPrice
        }

        // Set nonce if provided
        if (transactionParams.nonce !== undefined) {
            tx.nonce = transactionParams.nonce
        }

        // Estimate gas if not provided
        if (!tx.gasLimit) {
            tx.gasLimit = await wallet.estimateGas(tx)
        }

        console.log('Sending transaction:', tx)

        // Sign and send transaction
        const txResponse: TransactionResponse = await wallet.sendTransaction(tx)

        console.log(`Transaction sent with hash: ${txResponse.hash}`)

        // Wait for confirmation with timeout
        const receipt = await Promise.race([
            txResponse.wait(confirmations),
            new Promise<null>((_, reject) =>
                setTimeout(() => reject(new Error('Transaction confirmation timeout')), timeout)
            )
        ])

        const result: TransactionResult = {
            hash: txResponse.hash,
            receipt: receipt,
            success: receipt?.status === 1,
            gasUsed: receipt?.gasUsed,
            effectiveGasPrice: receipt?.gasPrice,
            blockNumber: receipt?.blockNumber,
            confirmations: confirmations
        }

        console.log(`Transaction ${result.success ? 'successful' : 'failed'}:`, result)

        return result

    } catch (error) {
        console.error('Transaction failed:', error)
        throw error
    }
}

/**
 * Send native token (ETH, BNB, MATIC, etc.)
 */
export const sendNativeToken = async (
    wallet: Wallet,
    to: string,
    amount: string | bigint, // Amount in wei
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<TransactionResult> => {
    return await signSendAndConfirm(
        wallet,
        {
            to,
            value: (Number(amount) * 10 ** 18).toString(),
            gasLimit
        },
        confirmations
    )
}

/**
 * Send ERC-20 token
 */
export const sendERC20Token = async (
    wallet: Wallet,
    tokenAddress: string,
    to: string,
    amount: string | bigint, // Amount in token's smallest unit
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<TransactionResult> => {
    try {
        // Create contract instance
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, wallet)

        // Encode transfer function call
        const data = tokenContract.interface.encodeFunctionData('transfer', [to, amount])

        return await signSendAndConfirm(
            wallet,
            {
                to: tokenAddress,
                data,
                gasLimit
            },
            confirmations
        )
    } catch (error) {
        console.error('ERC-20 transfer failed:', error)
        throw error
    }
}

/**
 * Execute any contract method
 */
export const executeContractMethod = async (
    wallet: Wallet,
    contractAddress: string,
    abi: any[],
    methodName: string,
    methodParams: any[] = [],
    value?: string | bigint, // For payable methods
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<TransactionResult> => {
    try {
        // Create contract instance
        const contract = new Contract(contractAddress, abi, wallet)

        // Encode method call
        const data = contract.interface.encodeFunctionData(methodName, methodParams)

        return await signSendAndConfirm(
            wallet,
            {
                to: contractAddress,
                data,
                value,
                gasLimit
            },
            confirmations
        )
    } catch (error) {
        console.error('Contract method execution failed:', error)
        throw error
    }
}

/**
 * Get current gas prices (both legacy and EIP-1559)
 */
export const getGasPrices = async (provider: JsonRpcProvider) => {
    try {
        const feeData = await provider.getFeeData()

        return {
            // Legacy
            gasPrice: feeData.gasPrice,
            // EIP-1559
            maxFeePerGas: feeData.maxFeePerGas,
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas
        }
    } catch (error) {
        console.error('Error fetching gas prices:', error)
        throw error
    }
}

/**
 * Estimate gas for a transaction
 */
export const estimateGas = async (
    provider: JsonRpcProvider,
    transactionParams: TransactionParams
): Promise<bigint> => {
    try {
        const tx: TransactionRequest = {
            to: transactionParams.to,
            value: transactionParams.value || 0,
            data: transactionParams.data || '0x'
        }

        return await provider.estimateGas(tx)
    } catch (error) {
        console.error('Gas estimation failed:', error)
        throw error
    }
}


/**
 * Check ERC-20 token allowance
 */
export const checkAllowance = async (
    tokenAddress: string,
    owner: string,
    spender: string,
    provider: JsonRpcProvider
): Promise<{
    allowance: bigint,
    formatted: string,
    decimals: number
}> => {
    try {
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, provider)

        // Get allowance and decimals
        const [allowance, decimals] = await Promise.all([
            tokenContract.allowance(owner, spender),
            tokenContract.decimals()
        ])

        // Format allowance for display
        const formattedAllowance = allowance / (10n ** BigInt(decimals))

        return {
            allowance,
            formatted: formattedAllowance.toString(),
            decimals
        }
    } catch (error) {
        console.error('Error checking allowance:', error)
        throw error
    }
}

/**
 * Check if allowance is sufficient for a transaction
 */
export const isAllowanceSufficient = async (
    tokenAddress: string,
    owner: string,
    spender: string,
    requiredAmount: string | bigint,
    provider: JsonRpcProvider
): Promise<boolean> => {
    try {
        const { allowance } = await checkAllowance(tokenAddress, owner, spender, provider)
        const required = typeof requiredAmount === 'string' ? BigInt(requiredAmount) : requiredAmount

        return allowance >= required
    } catch (error) {
        console.error('Error checking allowance sufficiency:', error)
        throw error
    }
}

/**
 * Approve ERC-20 token spending
 */
export const approveToken = async (
    wallet: Wallet,
    tokenAddress: string,
    spender: string,
    amount: string | bigint, // Amount to approve, use MaxUint256 for unlimited
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<TransactionResult> => {
    try {
        const tokenContract = new Contract(tokenAddress, ERC20_ABI, wallet)

        // Encode approve function call
        const data = tokenContract.interface.encodeFunctionData('approve', [spender, amount])

        return await signSendAndConfirm(
            wallet,
            {
                to: tokenAddress,
                data,
                gasLimit
            },
            confirmations
        )
    } catch (error) {
        console.error('Token approval failed:', error)
        throw error
    }
}

/**
 * Approve unlimited token spending (MaxUint256)
 */
export const approveTokenUnlimited = async (
    wallet: Wallet,
    tokenAddress: string,
    spender: string,
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<TransactionResult> => {
    // MaxUint256 = 2^256 - 1
    const MAX_UINT256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935"

    return await approveToken(wallet, tokenAddress, spender, MAX_UINT256, gasLimit, confirmations)
}

/**
 * Check allowance and approve if necessary
 */
export const checkAndApprove = async (
    wallet: Wallet,
    tokenAddress: string,
    spender: string,
    requiredAmount: string | bigint,
    approvalAmount?: string | bigint, // If not provided, will approve exactly the required amount
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<{
    approvalNeeded: boolean,
    currentAllowance: bigint,
    approvalResult?: TransactionResult
}> => {
    try {
        const owner = await wallet.getAddress()
        const provider = wallet.provider as JsonRpcProvider

        // Check current allowance
        const { allowance } = await checkAllowance(tokenAddress, owner, spender, provider)
        const required = typeof requiredAmount === 'string' ? BigInt(requiredAmount) : requiredAmount

        const approvalNeeded = allowance < required

        if (!approvalNeeded) {
            return {
                approvalNeeded: false,
                currentAllowance: allowance
            }
        }

        console.log(`Approval needed. Current: ${allowance}, Required: ${required}`)

        // Determine approval amount
        const amountToApprove = approvalAmount || required

        // Execute approval
        const approvalResult = await approveToken(
            wallet,
            tokenAddress,
            spender,
            amountToApprove,
            gasLimit,
            confirmations
        )

        return {
            approvalNeeded: true,
            currentAllowance: allowance,
            approvalResult
        }
    } catch (error) {
        console.error('Check and approve failed:', error)
        throw error
    }
}

/**
 * Reset token allowance to zero (security best practice before setting new allowance)
 */
export const resetAllowance = async (
    wallet: Wallet,
    tokenAddress: string,
    spender: string,
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<TransactionResult> => {
    return await approveToken(wallet, tokenAddress, spender, "0", gasLimit, confirmations)
}

/**
 * Safe approve: Reset to zero first, then approve the desired amount
 * (Some tokens like USDT require this)
 */
export const safeApprove = async (
    wallet: Wallet,
    tokenAddress: string,
    spender: string,
    amount: string | bigint,
    gasLimit?: string | bigint,
    confirmations: number = 1
): Promise<{
    resetResult: TransactionResult,
    approveResult: TransactionResult
}> => {
    try {
        console.log('Performing safe approve: reset then approve')

        // First reset to zero
        const resetResult = await resetAllowance(wallet, tokenAddress, spender, gasLimit, confirmations)

        if (!resetResult.success) {
            throw new Error('Failed to reset allowance to zero')
        }

        // Then approve the desired amount
        const approveResult = await approveToken(wallet, tokenAddress, spender, amount, gasLimit, confirmations)

        return {
            resetResult,
            approveResult
        }
    } catch (error) {
        console.error('Safe approve failed:', error)
        throw error
    }
}


//swaps



//kyber swap here
//docs -. https://docs.kyberswap.com/kyberswap-solutions/kyberswap-aggregator/developer-guides/execute-a-swap-with-the-aggregator-api
// the major constrain is that each function should return a transaction to sign, do not sign transaction or send transaction within util functions
// let the ChainWalletClass be the one to sign and send,
//so in you chainWallet.swap, you can have the futil swap function to get the transaction then another function to sign and send and confirm the transaction



export async function getKyberSwapRoute(params: KyberSwapParams): Promise<KyberSwapResponse> {
    const chainName = KYBER_SUPPORTED_CHAINS[params.chainId];
    if (!chainName) {
        throw new Error(`Unsupported chain ID: ${params.chainId}`);
    }

    const queryParams = new URLSearchParams({
        tokenIn: params.tokenIn,
        tokenOut: params.tokenOut,
        amountIn: params.amountIn,
    });

    if (params.feeAmount) queryParams.append('feeAmount', params.feeAmount);
    if (params.feeReceiver) queryParams.append('feeReceiver', params.feeReceiver);
    if (params.isInBps !== undefined) queryParams.append('isInBps', params.isInBps.toString());
    if (params.chargeFeeBy) queryParams.append('chargeFeeBy', params.chargeFeeBy);

    const url = `${KYBER_BASE_URL}/${chainName}/api/v1/routes?${queryParams}`;

    const headers: { [key: string]: string } = {};
    if (params.clientId) {
        headers['x-client-id'] = params.clientId;
    }

    try {
        const response = await fetch(url, { headers });
        const data = await response.json() as any;

        if (!response.ok) {
            throw new Error(`KyberSwap API error: ${data.message || response.statusText}`);
        }

        return data as KyberSwapResponse;
    } catch (error) {
        console.error('Error fetching KyberSwap route:', error);
        throw error;
    }
}


export async function buildKyberSwapTransaction(
    chainId: string,
    routeSummary: KyberRoute,
    sender: string,
    recipient: string,
    slippageTolerance: number = 100,
    deadline?: number,
    clientId?: string
): Promise<KyberBuildResponse> {
    const chainName = KYBER_SUPPORTED_CHAINS[chainId];
    if (!chainName) {
        throw new Error(`Unsupported chain ID: ${chainId}`);
    }

    const url = `${KYBER_BASE_URL}/${chainName}/api/v1/route/build`;

    const txDeadline = deadline || Math.floor(Date.now() / 1000) + 1200;

    const body = {
        routeSummary,
        sender,
        recipient,
        slippageTolerance,
        deadline: txDeadline,
        source: clientId || 'MyWalletApp'
    };

    const headers: { [key: string]: string } = {
        'Content-Type': 'application/json',
    };

    if (clientId) {
        headers['x-client-id'] = clientId;
    }

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });

        const data = await response.json() as any;

        if (!response.ok) {
            throw new Error(`KyberSwap build API error: ${data.message || response.statusText}`);
        }

        return data as KyberBuildResponse;
    } catch (error) {
        console.error('Error building KyberSwap transaction:', error);
        throw error;
    }
}

export async function performSwap(params: {
    chainId: string;
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    sender: string;
    recipient?: string;
    slippageTolerance?: number;
    deadline?: number;
    feeAmount?: string;
    feeReceiver?: string;
    isInBps?: boolean;
    chargeFeeBy?: 'currency_in' | 'currency_out';
    clientId?: string;
}): Promise<TransactionParams> {
    if (!KYBER_SUPPORTED_CHAINS[params.chainId]) {
        throw new Error(`KyberSwap does not support chain ID: ${params.chainId}`);
    }
    try {
        console.log('Starting KyberSwap aggregation...', {
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            amountIn: params.amountIn,
            chainId: params.chainId
        });
        
        console.log('Fetching best swap route across all DEXs...');
        
        const routeResponse = await getKyberSwapRoute({
            chainId: params.chainId,
            tokenIn: params.tokenIn,
            tokenOut: params.tokenOut,
            amountIn: params.amountIn,
            feeAmount: params.feeAmount,
            feeReceiver: params.feeReceiver,
            isInBps: params.isInBps,
            chargeFeeBy: params.chargeFeeBy,
            clientId: params.clientId || 'MyWalletApp'
        });

        // Debug: Log the full response to understand structure
        console.log('Full KyberSwap route response:', JSON.stringify(routeResponse, null, 2));

        if (!routeResponse.data || !routeResponse.data.routeSummary) {
            throw new Error('No valid route found for the swap');
        }

        const { routeSummary, routerAddress } = routeResponse.data;
        
        // Debug: Log what we actually received
        console.log('routeSummary keys:', Object.keys(routeSummary));
        console.log('routeSummary.swaps exists:', !!routeSummary.swaps);

        // Safe logging that handles undefined swaps
        console.log('Best route found:', {
            tokenIn: routeSummary.tokenIn,
            tokenOut: routeSummary.tokenOut,
            amountIn: routeSummary.amountIn,
            amountOut: routeSummary.amountOut,
            gasEstimate: routeSummary.gas,
            routerAddress,
            // Only try to access swaps if it exists
            swapsCount: routeSummary.swaps ? routeSummary.swaps.length : 0,
            // Only extract exchange names if swaps exists and has the expected structure
            dexSources: routeSummary.swaps && Array.isArray(routeSummary.swaps) 
                ? routeSummary.swaps.map(swap => swap?.exchange || 'unknown').filter(Boolean)
                : ['unknown']
        });

        console.log('Building executable transaction...');
        
        const buildResponse = await buildKyberSwapTransaction(
            params.chainId,
            routeSummary,
            params.sender,
            params.recipient || params.sender,
            params.slippageTolerance || 100,
            params.deadline,
            params.clientId || 'MyWalletApp'
        );

        // Debug: Log build response
        console.log('Build response:', JSON.stringify(buildResponse, null, 2));

        if (!buildResponse.data || !buildResponse.data.data) {
            throw new Error('Failed to build transaction data');
        }

        const { data: encodedData, gas, routerAddress: finalRouterAddress } = buildResponse.data;

        console.log('Transaction built successfully:', {
            to: finalRouterAddress,
            dataLength: encodedData.length,
            gasEstimate: gas,
            expectedOutput: buildResponse.data.amountOut
        });

        return {
            to: finalRouterAddress,
            data: encodedData,
            gasLimit: gas,
            value: params.tokenIn.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
                ? params.amountIn
                : '0'
        };

    } catch (error) {
        console.error('KyberSwap aggregation failed:', error);
        
        // More detailed error logging
        if (error instanceof Error) {
            console.error('Error details:', {
                message: error.message,
                stack: error.stack,
                name: error.name
            });
        }
        
        throw new Error(`Swap preparation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

export function getKyberSupportedChains(): { [key: string]: string } {
    return { ...KYBER_SUPPORTED_CHAINS };
}

export function isChainSupportedByKyber(chainId: string): boolean {
    return chainId in KYBER_SUPPORTED_CHAINS;
}

export function isChainSupportedByDebonk(chainId: string): boolean {
    return chainId in DESERIALIZED_SUPPORTED_CHAINS;
}

export function getNativeTokenAddress(): string {
    return '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
}

export function formatAmountToWei(amount: string, decimals: number): string {
    return parseUnits(amount, decimals).toString();
}
export function formatAmountFromWei(amountWei: string, decimals: number): string {
    return formatUnits(amountWei, decimals);
}

export function prepareSwapParams(
    tokenIn: string,
    tokenOut: string,
    amountIn: string,
    tokenInDecimals: number,
    isNativeIn: boolean = false,
    isNativeOut: boolean = false
): {
    tokenInAddress: string;
    tokenOutAddress: string;
    formattedAmountIn: string;
} {
    const tokenInAddress = isNativeIn ? getNativeTokenAddress() : tokenIn;
    const tokenOutAddress = isNativeOut ? getNativeTokenAddress() : tokenOut;

    const formattedAmountIn = amountIn.includes('.')
        ? formatAmountToWei(amountIn, tokenInDecimals)
        : amountIn;

    return {
        tokenInAddress,
        tokenOutAddress,
        formattedAmountIn
    };
}

/**
 * Normalize token address for Debonk
 * Converts 'native' or variations to the standard 0xEeeee... address
 */
// export function normalizeTokenAddressForDebonk(tokenAddress: string): string {
//     if (tokenAddress === 'native' || 
//         tokenAddress.toLowerCase() === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
//         return getNativeTokenAddress();
//     }
//     return tokenAddress;
// }

/**
 * Convert slippage from basis points to percentage for Debonk
 * Input: 50 (0.5% in bps) -> Output: 0.5 (percentage)
 */
export function convertSlippageForDebonk(slippageBps: number): number {
    return slippageBps / 100;
}
