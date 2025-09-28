# ioBroker Adapter Development with GitHub Copilot

**Version:** 0.4.0
**Template Source:** https://github.com/DrozmotiX/ioBroker-Copilot-Instructions

This file contains instructions and best practices for GitHub Copilot when working on ioBroker adapter development.

## Project Context

You are working on an ioBroker adapter. ioBroker is an integration platform for the Internet of Things, focused on building smart home and industrial IoT solutions. Adapters are plugins that connect ioBroker to external systems, devices, or services.

## Adapter-Specific Context
- **Adapter Name**: ioBroker.fritzbox
- **Primary Function**: Monitors call information from AVM FRITZ!Box routers via TCP port 1012
- **Key Features**: 
  - Call monitoring and logging (incoming, outgoing, missed calls)
  - Real-time call status tracking
  - TAM (Telephone Answering Machine) support
  - Phone book integration
  - WLAN control
  - JSON, HTML, and TXT output formats for call data
- **Target Device**: AVM FRITZ!Box routers and compatible devices
- **Connection Method**: TCP connection to port 1012 on FRITZ!Box, TR-064 protocol for extended features
- **Configuration Requirements**: FRITZ!Box IP address, username/password, call monitor activation (#96*5*)

## Development Patterns

### Logging and Error Handling
Always use appropriate ioBroker logging levels:
```javascript
this.log.error('Critical error message');   // For errors that break functionality
this.log.warn('Warning message');           // For issues that don't break functionality
this.log.info('Informational message');     // For important state changes
this.log.debug('Debug information');        // For detailed debugging (only in debug mode)
```

### State Management
Follow ioBroker patterns for state creation and updates:
```javascript
// Create states during adapter startup
await this.setObjectNotExistsAsync('calls.ring', {
    type: 'state',
    common: {
        name: 'ring activ?',
        type: 'boolean',
        role: 'call info',
        read: true,
        write: false
    },
    native: {}
});

// Update states
await this.setStateAsync('calls.ring', { val: true, ack: true });
```

### Connection Management
For FRITZ!Box adapters, implement proper connection handling:
```javascript
// TCP connection for call monitoring
const net = require('net');
const client = new net.Socket();

client.connect(1012, this.config.fritzboxAddress, () => {
    this.log.info('Connected to FRITZ!Box call monitor');
});

client.on('data', (data) => {
    // Process call monitor data
});

client.on('error', (err) => {
    this.log.error('Connection error: ' + err.message);
});
```

### Resource Cleanup
Ensure proper cleanup in the unload method:
```javascript
unload(callback) {
    try {
        if (this.client) {
            this.client.destroy();
        }
        if (this.connectionTimer) {
            clearTimeout(this.connectionTimer);
        }
        callback();
    } catch (e) {
        callback();
    }
}
```

## Testing

### Unit Testing
- Use Jest as the primary testing framework for ioBroker adapters
- Create tests for all adapter main functions and helper methods
- Test error handling scenarios and edge cases
- Mock external API calls and hardware dependencies
- For adapters connecting to APIs/devices not reachable by internet, provide example data files to allow testing of functionality without live connections
- Example test structure:
  ```javascript
  describe('AdapterName', () => {
    let adapter;
    
    beforeEach(() => {
      // Setup test adapter instance
    });
    
    test('should initialize correctly', () => {
      // Test adapter initialization
    });
  });
  ```

### Integration Testing

**IMPORTANT**: Use the official `@iobroker/testing` framework for all integration tests. This is the ONLY correct way to test ioBroker adapters.

**Official Documentation**: https://github.com/ioBroker/testing

#### Framework Structure
Integration tests MUST follow this exact pattern:

```javascript
const path = require('path');
const { tests } = require('@iobroker/testing');

// Define test coordinates or configuration
const TEST_COORDINATES = '52.520008,13.404954'; // Berlin
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Use tests.integration() with defineAdditionalTests
tests.integration(path.join(__dirname, '..'), {
    defineAdditionalTests({ suite }) {
        suite('Test adapter with specific configuration', (getHarness) => {
            let harness;

            before(() => {
                harness = getHarness();
            });

            it('should configure and start adapter', function () {
                return new Promise(async (resolve, reject) => {
                    try {
                        harness = getHarness();
                        
                        // Get adapter object using promisified pattern
                        const obj = await new Promise((res, rej) => {
                            harness.objects.getObject('system.adapter.your-adapter.0', (err, o) => {
                                if (err) return rej(err);
                                res(o);
                            });
                        });
                        
                        if (!obj) {
                            return reject(new Error('Adapter object not found'));
                        }

                        // Configure adapter properties
                        Object.assign(obj.native, {
                            position: TEST_COORDINATES,
                            createCurrently: true,
                            createHourly: true,
                            createDaily: true,
                            // Add other configuration as needed
                        });

                        // Set the updated configuration
                        harness.objects.setObject(obj._id, obj);

                        console.log('✅ Step 1: Configuration written, starting adapter...');
                        
                        // Start adapter and wait
                        await harness.startAdapterAndWait();
                        
                        console.log('✅ Step 2: Adapter started');

                        // Wait for adapter to process data
                        const waitMs = 15000;
                        await wait(waitMs);

                        console.log('🔍 Step 3: Checking states after adapter run...');
                        
                        // Get and verify states
                        const states = await harness.states.getStatesAsync('your-adapter.0.*');
                        
                        // Assert expected states exist
                        expect(states).to.have.property('your-adapter.0.info.connection');
                        expect(states['your-adapter.0.info.connection']).to.not.be.undefined;
                        
                        resolve();
                    } catch (error) {
                        console.error('❌ Test failed:', error.message);
                        reject(error);
                    }
                });
            });
        });
    }
});
```

#### Key Testing Requirements
1. **Always use `@iobroker/testing`** - No other testing approach is acceptable
2. **Use `defineAdditionalTests`** - This is the correct pattern for custom integration tests  
3. **Follow the promisified pattern** - Don't mix callbacks and promises
4. **Test with realistic data** - Use coordinates, API keys, or sample data that represent real usage
5. **Include proper waits** - Allow time for adapter to process data before assertions
6. **Verify state creation** - Check that expected states are created and populated
7. **Test error scenarios** - Include tests for invalid configurations

#### Invalid Testing Approaches (DO NOT USE)
```javascript
// ❌ WRONG: Direct adapter instantiation
const AdapterClass = require('../main.js');
const adapter = new AdapterClass({});

// ❌ WRONG: Manual mocking of adapter-core
const utils = {
    Adapter: function() { return {}; }
};

// ❌ WRONG: Using other testing frameworks without @iobroker/testing
describe('Integration test', () => {
    // This will not work correctly
});
```

## ioBroker Architecture Patterns

### Adapter Lifecycle
Follow the standard ioBroker adapter lifecycle:
```javascript
class YourAdapter extends utils.Adapter {
    constructor(options = {}) {
        super({
            ...options,
            name: 'your-adapter',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    async onReady() {
        // Initialize adapter
    }

    onStateChange(id, state) {
        // Handle state changes
    }

    onUnload(callback) {
        // Cleanup resources
        callback();
    }
}
```

### Configuration Management
Use JSON configuration properly:
```javascript
// Access configuration
const fritzboxIP = this.config.fritzboxAddress;
const username = this.config.fritzboxUser;
const password = this.config.fritzboxPassword;

// Validate configuration
if (!fritzboxIP) {
    this.log.error('FRITZ!Box IP address not configured');
    return;
}
```

### State Definitions
Define states according to ioBroker standards:
```javascript
const stateDefinitions = {
    'calls.ring': {
        type: 'state',
        common: {
            name: 'Ring active',
            type: 'boolean',
            role: 'indicator',
            read: true,
            write: false
        }
    }
};
```

## Error Handling Best Practices

### Network Connection Errors
```javascript
// Handle connection timeouts and network issues
client.setTimeout(30000);
client.on('timeout', () => {
    this.log.warn('Connection to FRITZ!Box timed out');
    client.destroy();
});

client.on('error', (err) => {
    this.log.error(`Network error: ${err.message}`);
    // Implement reconnection logic
    this.scheduleReconnect();
});
```

### API Response Validation
```javascript
// Always validate external API responses
if (response && response.statusCode === 200) {
    try {
        const data = JSON.parse(response.body);
        if (data && data.calls) {
            this.processCallData(data.calls);
        } else {
            this.log.warn('Invalid response format from FRITZ!Box');
        }
    } catch (err) {
        this.log.error(`JSON parsing error: ${err.message}`);
    }
} else {
    this.log.error(`HTTP error: ${response.statusCode}`);
}
```

## Code Style and Standards

- Follow JavaScript/TypeScript best practices
- Use async/await for asynchronous operations
- Implement proper resource cleanup in `unload()` method
- Use semantic versioning for adapter releases
- Include proper JSDoc comments for public methods

## CI/CD and Testing Integration

### GitHub Actions for API Testing
For adapters with external API dependencies, implement separate CI/CD jobs:

```yaml
# Tests API connectivity with demo credentials (runs separately)
demo-api-tests:
  if: contains(github.event.head_commit.message, '[skip ci]') == false
  
  runs-on: ubuntu-22.04
  
  steps:
    - name: Checkout code
      uses: actions/checkout@v4
      
    - name: Use Node.js 20.x
      uses: actions/setup-node@v4
      with:
        node-version: 20.x
        cache: 'npm'
        
    - name: Install dependencies
      run: npm ci
      
    - name: Run demo API tests
      run: npm run test:integration-demo
```

### CI/CD Best Practices
- Run credential tests separately from main test suite
- Use ubuntu-22.04 for consistency
- Don't make credential tests required for deployment
- Provide clear failure messages for API connectivity issues
- Use appropriate timeouts for external API calls (120+ seconds)

### Package.json Script Integration
Add dedicated script for credential testing:
```json
{
  "scripts": {
    "test:integration-demo": "mocha test/integration-demo --exit"
  }
}
```

### Practical Example: Complete API Testing Implementation
Here's a complete example based on lessons learned from the Discovergy adapter:

#### test/integration-demo.js
```javascript
const path = require("path");
const { tests } = require("@iobroker/testing");

// Helper function to encrypt password using ioBroker's encryption method
async function encryptPassword(harness, password) {
    const systemConfig = await harness.objects.getObjectAsync("system.config");
    
    if (!systemConfig || !systemConfig.native || !systemConfig.native.secret) {
        throw new Error("Could not retrieve system secret for password encryption");
    }
    
    const secret = systemConfig.native.secret;
    let result = '';
    for (let i = 0; i < password.length; ++i) {
        result += String.fromCharCode(secret[i % secret.length].charCodeAt(0) ^ password.charCodeAt(i));
    }
    
    return result;
}

// Run integration tests with demo credentials
tests.integration(path.join(__dirname, ".."), {
    defineAdditionalTests({ suite }) {
        suite("API Testing with Demo Credentials", (getHarness) => {
            let harness;
            
            before(() => {
                harness = getHarness();
            });

            it("Should connect to API and initialize with demo credentials", async () => {
                console.log("Setting up demo credentials...");
                
                if (harness.isAdapterRunning()) {
                    await harness.stopAdapter();
                }
                
                const encryptedPassword = await encryptPassword(harness, "demo_password");
                
                await harness.changeAdapterConfig("your-adapter", {
                    native: {
                        username: "demo@provider.com",
                        password: encryptedPassword,
                        // other config options
                    }
                });

                console.log("Starting adapter with demo credentials...");
                await harness.startAdapter();
                
                // Wait for API calls and initialization
                await new Promise(resolve => setTimeout(resolve, 60000));
                
                const connectionState = await harness.states.getStateAsync("your-adapter.0.info.connection");
                
                if (connectionState && connectionState.val === true) {
                    console.log("✅ SUCCESS: API connection established");
                    return true;
                } else {
                    throw new Error("API Test Failed: Expected API connection to be established with demo credentials. " +
                        "Check logs above for specific API errors (DNS resolution, 401 Unauthorized, network issues, etc.)");
                }
            }).timeout(120000);
        });
    }
});
```

## FRITZ!Box Specific Development Patterns

### Call Monitor Data Parsing
```javascript
// Parse FRITZ!Box call monitor data format
parseCallMonitorData(data) {
    const lines = data.toString().trim().split('\n');
    
    for (const line of lines) {
        const parts = line.split(';');
        if (parts.length >= 5) {
            const [timestamp, type, id, extension, number] = parts;
            
            const call = {
                timestamp: new Date(parseInt(timestamp) * 1000),
                type: type, // RING, CALL, CONNECT, DISCONNECT
                id: id,
                extension: extension,
                number: this.formatPhoneNumber(number)
            };
            
            this.processCallEvent(call);
        }
    }
}
```

### TR-064 Integration
```javascript
// Use TR-064 for extended FRITZ!Box features
connectToTR064(host, user, password, callback) {
    const tr064 = require('tr-064');
    const tr = new tr064.TR064();
    
    tr.initTR064Device(host, 49000, (err, device) => {
        if (err) {
            this.log.error('TR-064 connection failed: ' + err.message);
            return;
        }
        
        device.startEncryptedCommunication((err, sslDev) => {
            if (err) {
                this.log.error('TR-064 SSL setup failed: ' + err.message);
                return;
            }
            
            sslDev.login(user, password);
            callback(sslDev);
        });
    });
}
```

### Phone Number Formatting
```javascript
// Format phone numbers according to configuration
formatPhoneNumber(number) {
    if (!number || number === '') return this.config.unknownNumber;
    
    // Remove leading zeros and format
    let formatted = number.replace(/^0+/, '');
    
    // Apply country and area code formatting
    if (this.config.cc && this.config.ac) {
        // Add formatting logic based on configuration
    }
    
    // Truncate to configured length
    if (formatted.length > this.config.numberLength) {
        formatted = formatted.substring(0, this.config.numberLength);
    }
    
    return formatted;
}
```

This comprehensive guide provides GitHub Copilot with the necessary context to effectively assist with ioBroker.fritzbox adapter development, including specific patterns for FRITZ!Box integration, call monitoring, and ioBroker best practices.