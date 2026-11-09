// Core factories
export { createProducer } from './producer';
export { createConsumer } from './consumer';

// Topic management
export { ensureTopics, buildTopicList, TOPIC_PRESETS } from './admin';

// Graceful shutdown
export { onShutdown, registerShutdownHandlers } from './shutdown';

// DLQ — used internally by consumer; exposed for replay scripts
export { sendToDlq, disconnectDlq } from './dlq';

// Connection — exposed for advanced use (e.g. testing)
export { getKafkaInstance, resetKafkaInstance } from './connection';

// Types
export type {
  ProducerConfig,
  SendOptions,
  WheelersProducer,
  ConsumerConfig,
  MessageContext,
  MessageHandler,
  WheelersConsumer,
  TopicDefinition,
  DlqPayload,
} from './types';export { consumerLag } from './lag';
