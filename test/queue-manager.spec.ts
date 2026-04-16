import 'reflect-metadata';

// Mock BullMQ before importing the service
jest.mock('bullmq', () => {
  const mockQueueInstance = {
    add: jest.fn().mockResolvedValue({ id: 'job-1', name: 'test' }),
    addBulk: jest.fn().mockResolvedValue([]),
    close: jest.fn().mockResolvedValue(undefined),
    obliterate: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(1),
    getJobs: jest.fn().mockResolvedValue([]),
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0,
    }),
    pause: jest.fn().mockResolvedValue(undefined),
    resume: jest.fn().mockResolvedValue(undefined),
  };

  const mockQueueEventsInstance = {
    close: jest.fn().mockResolvedValue(undefined),
  };

  return {
    Queue: jest.fn().mockImplementation(() => ({ ...mockQueueInstance })),
    QueueEvents: jest.fn().mockImplementation(() => ({ ...mockQueueEventsInstance })),
    Worker: jest.fn(),
    Job: jest.fn(),
  };
});

import { QueueManagerService } from '../src/services/queue-manager/queue-manager.service';
import { IAtomicQueuesModuleConfig } from '../src/domain';
import { Queue } from 'bullmq';

const mockRedis = {
  duplicate: jest.fn().mockReturnThis(),
};

const mockConfig: IAtomicQueuesModuleConfig = {
  redis: { host: 'localhost', port: 6379 },
  keyPrefix: 'test',
};

describe('QueueManagerService', () => {
  let service: QueueManagerService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new QueueManagerService(mockRedis as any, mockConfig);
  });

  describe('getOrCreateQueue', () => {
    it('should create a new queue', () => {
      const queue = service.getOrCreateQueue('my-queue');
      expect(queue).toBeDefined();
      expect(Queue).toHaveBeenCalled();
    });

    it('should return existing queue on second call', () => {
      const q1 = service.getOrCreateQueue('same-queue');
      const q2 = service.getOrCreateQueue('same-queue');
      // Queue constructor should only be called once for the same name
      // (plus once for the suffixed normalization)
      expect(q1).toBe(q2);
    });

    it('should normalize names without prefix', () => {
      service.getOrCreateQueue('simple');
      // "simple" should become "simple-queue"
      expect(service.hasQueue('simple')).toBe(true);
    });

    it('should preserve names with colons', () => {
      service.getOrCreateQueue('test:user:123:queue');
      expect(service.hasQueue('test:user:123:queue')).toBe(true);
    });
  });

  describe('getOrCreateEntityQueue', () => {
    it('should create entity-specific queue with naming convention', () => {
      const queue = service.getOrCreateEntityQueue('user', '123');
      expect(queue).toBeDefined();
      expect(service.hasQueue('test:user:123:queue')).toBe(true);
    });

    it('should return existing entity queue', () => {
      const q1 = service.getOrCreateEntityQueue('table', 't-1');
      const q2 = service.getOrCreateEntityQueue('table', 't-1');
      expect(q1).toBe(q2);
    });
  });

  describe('getQueueNames', () => {
    it('should return all managed queue names', () => {
      service.getOrCreateQueue('test:a:1:queue');
      service.getOrCreateQueue('test:b:2:queue');

      const names = service.getQueueNames();
      expect(names).toContain('test:a:1:queue');
      expect(names).toContain('test:b:2:queue');
    });
  });

  describe('closeQueue', () => {
    it('should close and remove a queue', async () => {
      const queue = service.getOrCreateQueue('test:close:1:queue');
      await service.closeQueue('test:close:1:queue');

      expect(queue.close).toHaveBeenCalled();
      expect(service.hasQueue('test:close:1:queue')).toBe(false);
    });

    it('should not throw for non-existent queue', async () => {
      await expect(service.closeQueue('nonexistent:queue')).resolves.toBeUndefined();
    });
  });

  describe('closeAllQueues', () => {
    it('should close all queues', async () => {
      service.getOrCreateQueue('test:q1:queue');
      service.getOrCreateQueue('test:q2:queue');

      await service.closeAllQueues();
      expect(service.getQueueNames()).toHaveLength(0);
    });
  });

  describe('addJob', () => {
    it('should add a job to a queue', async () => {
      const job = await service.addJob('test:q:1:queue', 'my-job', { data: 1 });
      expect(job).toBeDefined();
    });

    it('should merge job options with defaults', async () => {
      const queue = service.getOrCreateQueue('test:q:2:queue');
      await service.addJob('test:q:2:queue', 'job', { x: 1 }, { priority: 5 });

      expect(queue.add).toHaveBeenCalledWith(
        'job',
        { x: 1 },
        expect.objectContaining({
          priority: 5,
          removeOnComplete: true,
          removeOnFail: false,
        }),
      );
    });
  });

  describe('deleteJob', () => {
    it('should remove a job from a queue', async () => {
      const queue = service.getOrCreateQueue('test:q:3:queue');
      await service.deleteJob('test:q:3:queue', 'job-42');
      expect(queue.remove).toHaveBeenCalledWith('job-42');
    });
  });

  describe('getEntityTypeQueues', () => {
    it('should filter queues by entity type', () => {
      service.getOrCreateEntityQueue('user', 'u-1');
      service.getOrCreateEntityQueue('user', 'u-2');
      service.getOrCreateEntityQueue('table', 't-1');

      const userQueues = service.getEntityTypeQueues('user');
      expect(userQueues).toHaveLength(2);
    });
  });

  describe('getManagedQueue', () => {
    it('should return managed queue info', () => {
      service.getOrCreateEntityQueue('game', 'g-1');
      const managed = service.getManagedQueue('test:game:g-1:queue');

      expect(managed).toBeDefined();
      expect(managed!.entityType).toBe('game');
      expect(managed!.entityId).toBe('g-1');
      expect(managed!.createdAt).toBeInstanceOf(Date);
    });

    it('should return undefined for unknown queue', () => {
      expect(service.getManagedQueue('nope')).toBeUndefined();
    });
  });

  describe('pauseQueue / resumeQueue', () => {
    it('should pause a queue', async () => {
      const queue = service.getOrCreateQueue('test:pause:queue');
      await service.pauseQueue('test:pause:queue');
      expect(queue.pause).toHaveBeenCalled();
    });

    it('should resume a queue', async () => {
      const queue = service.getOrCreateQueue('test:resume:queue');
      await service.resumeQueue('test:resume:queue');
      expect(queue.resume).toHaveBeenCalled();
    });
  });

  describe('onModuleDestroy', () => {
    it('should close all queues and queue events', async () => {
      service.getOrCreateQueue('test:destroy:queue');
      await service.onModuleDestroy();
      expect(service.getQueueNames()).toHaveLength(0);
    });
  });
});
