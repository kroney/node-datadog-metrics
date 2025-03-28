'use strict';
const { client: datadogApiClient, v1: v1Client } = require('@datadog/datadog-api-client');
const { AuthorizationError } = require('./errors');
const { logDebug, logDeprecation } = require('./logging');

const RETRYABLE_ERROR_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'ENOTFOUND',
    'EPIPE',
    'ETIMEDOUT'
]);

async function sleep(milliseconds) {
    await new Promise((r) => setTimeout(r, milliseconds));
}

/**
 * A Reporter that throws away metrics instead of sending them to Datadog. This
 * is useful for disabling metrics in your application and for tests.
 */
class NullReporter {
    async report(_series) {
        // Do nothing.
    }
}

/**
 * @private
 * A custom HTTP implementation for Datadog that retries failed requests.
 * Datadog has retries built in, but they don't handle network errors (just
 * HTTP errors), and we want to retry in both cases. This inherits from the
 * built-in HTTP library since we want to use the same fetch implementation
 * Datadog uses instead of adding another dependency.
 */
class RetryHttp extends datadogApiClient.IsomorphicFetchHttpLibrary {
    constructor(options = {}) {
        super(options);

        // HACK: ensure enableRetry is always `false` so the base class logic
        // does not actually retry (since we manage retries here).
        Object.defineProperty(this, 'enableRetry', {
            get () { return false; },
            set () {},
        });
    }

    async send(request) {
        let i = 0;
        while (true) {  // eslint-disable-line no-constant-condition
            let response, error;
            try {
                response = await super.send(request);
            } catch (e) {
                error = e;
            }

            if (this.isRetryable(response || error, i)) {
                await sleep(this.retryDelay(response || error, i));
            } else if (response) {
                return response;
            } else {
                throw error;
            }

            i++;
        }
    }

    /**
     * @private
     * @param {any} response HTTP response or error object
     * @returns {boolean}
     */
    isRetryable(response, tryCount) {
        return tryCount < this.maxRetries && (
            RETRYABLE_ERROR_CODES.has(response.code)
            || response.httpStatusCode === 429
            || response.httpStatusCode >= 500
        );
    }

    /**
     * @private
     * @param {any} response HTTP response or error object
     * @param {number} tryCount
     * @returns {number}
     */
    retryDelay(response, tryCount) {
        if (response.httpStatusCode === 429) {
            // Datadog's official client supports just the 'x-ratelimit-reset'
            // header, so we support that here in addition to the standardized
            // 'retry-after' heaer.
            // There is also an upcoming IETF standard for 'ratelimit', but it
            // has moved away from the syntax used in 'x-ratelimit-reset'. This
            // stuff might change in the future.
            // https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/
            const delayHeader = response.headers['retry-after']
                || response.headers['x-ratelimit-reset'];
            const delayValue = parseInt(delayHeader, 10);
            if (!isNaN(delayValue) && delayValue > 0) {
                return delayValue * 1000;
            }
        }

        return this.backoffMultiplier ** tryCount * this.backoffBase * 1000;
    }
}

/**
 * @typedef {Object} DatadogReporterOptions
 * @property {string} [apiKey] Datadog API key.
 * @property {string} [appKey] DEPRECATED! This option does nothing.
 * @property {string} [site] The Datadog "site" to send metrics to.
 * @property {number} [retries] Retry failed requests up to this many times.
 * @property {number} [retryBackoff] Delay before retries. Subsequent retries
 *           wait this long multiplied by 2^(retry count).
 */

/** @type {WeakMap<DatadogReporter, v1Client.MetricsApi>} */
const datadogClients = new WeakMap();

/**
 * Create a reporter that sends metrics to Datadog's API.
 */
class DatadogReporter {
    /**
     * Create a reporter that sends metrics to Datadog's API.
     * @param {DatadogReporterOptions} [options]
     */
    constructor(options = {}) {
        if (typeof options !== 'object') {
            throw new TypeError('DatadogReporter takes an options object, not multiple string arguments.');
        }

        if (options.appKey) {
            logDeprecation(
                'The `appKey` option is no longer supported since it is ' +
                'not used for submitting metrics, distributions, events, ' +
                'or logs.'
            );
        }

        const apiKey = options.apiKey || process.env.DATADOG_API_KEY || process.env.DD_API_KEY;
        this.site = options.site
            || process.env.DATADOG_SITE
            || process.env.DD_SITE
            || process.env.DATADOG_API_HOST;

        if (!apiKey) {
            throw new Error(
                'Datadog API key not found. You must specify one via the ' +
                '`apiKey` configuration option or the DATADOG_API_KEY or ' +
                'DD_API_KEY environment variable.'
            );
        }

        const configuration = datadogApiClient.createConfiguration({
            authMethods: {
                apiKeyAuth: apiKey,
            },
            httpApi: new RetryHttp(),
            maxRetries: options.retries >= 0 ? options.retries : 2,
        });

        // HACK: Specify backoff here rather than in configration options to
        // support values less than 2 (mainly for faster tests).
        const backoff = options.retryBackoff >= 0 ? options.retryBackoff : 1;
        configuration.httpApi.backoffBase = backoff;

        if (this.site) {
            // Strip leading `app.` from the site in case someone copy/pasted the
            // URL from their web browser. More details on correct configuration:
            // https://docs.datadoghq.com/getting_started/site/#access-the-datadog-site
            this.site = this.site.replace(/^app\./i, '');
            configuration.setServerVariables({
                site: this.site
            });
        }

        datadogClients.set(this, new v1Client.MetricsApi(configuration));
    }

    /**
     * Send an array of serialized metrics to Datadog.
     * @param {any[]} series
     * @returns {Promise}
     */
    async report(series) {
        logDebug('Calling report with %j', series);

        // Distributions must be submitted via a different method than other
        // metrics, so split them up.
        const metrics = [];
        const distributions = [];
        for (const metric of series) {
            if (metric.type === 'distribution') {
                distributions.push(metric);
            } else {
                metrics.push(metric);
            }
        }

        const metricsApi = datadogClients.get(this);

        let submissions = [];
        if (metrics.length) {
            submissions.push(metricsApi.submitMetrics({
                body: { series: metrics }
            }));
        }
        if (distributions.length) {
            submissions.push(metricsApi.submitDistributionPoints({
                body: { series: distributions }
            }));
        }

        try {
            await Promise.all(submissions);
            logDebug('sent metrics successfully');
        } catch (error) {
            if (error.code === 403) {
                throw new AuthorizationError(
                    'Your Datadog API key is not authorized to send ' +
                    'metrics. Check to make sure the DATADOG_API_KEY or ' +
                    'DD_API_KEY environment variable or the `apiKey` init ' +
                    'option is set to a valid API key for your Datadog ' +
                    'account, and that it is not an *application* key. ' +
                    'For more, see: ' +
                    'https://docs.datadoghq.com/account_management/api-app-keys/',
                    { cause: error }
                );
            }

            throw error;
        }
    }
}

/**
 * @deprecated Please use `DatadogReporter` instead.
 */
class DataDogReporter extends DatadogReporter {
    /**
     * Create a reporter that sends metrics to Datadog's API.
     * @deprecated
     * @param {string} [apiKey]
     * @param {string} [appKey]
     * @param {string} [site]
     */
    constructor(apiKey, appKey, site) {
        logDeprecation(
            'DataDogReporter has been renamed to DatadogReporter (lower-case ' +
            'D in "dog"); the old name will be removed in a future release.'
        );
        super({ apiKey, appKey, site });
    }
}

module.exports = {
    NullReporter,
    DatadogReporter,
    DataDogReporter
};
