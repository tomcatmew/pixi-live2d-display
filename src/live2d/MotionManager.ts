import ExpressionManager from '@/live2d/ExpressionManager';
import ModelSettings from '@/live2d/ModelSettings';
import { MotionDefinition } from '@/live2d/ModelSettingsJSON';
import { log, warn } from '@/utils/log';
import { Loader, LoaderResource } from '@pixi/loaders';

export enum Priority {
    None = 0,
    Idle = 1,
    Normal = 2,
    Force = 3,
}

enum Group {
    Idle = 'idle',
}

const DEFAULT_FADE_TIMEOUT = 500;

export default class MotionManager extends MotionQueueManager {
    tag: string;

    definitions: { [group: string]: MotionDefinition[] };
    motionGroups: { [group: string]: Live2DMotion[] } = {};

    expressionManager?: ExpressionManager;

    currentPriority = Priority.None;
    reservePriority = Priority.None;

    constructor(readonly coreModel: Live2DModelWebGL, readonly modelSettings: ModelSettings) {
        super();

        this.tag = `MotionManager\n(${modelSettings.name})`;

        if (!modelSettings.motions) {
            throw new TypeError('Missing motion definitions.');
        }

        this.definitions = modelSettings.motions;

        if (modelSettings.expressions) {
            this.expressionManager = new ExpressionManager(coreModel, modelSettings);
        }

        this.setupMotions();
        this.stopAllMotions();
    }

    private setupMotions() {
        // initialize all motion groups with empty arrays
        Object.keys(this.definitions).forEach(group => (this.motionGroups[group] = []));

        // preload idle motions
        this.loadMotion(Group.Idle).then();
    }

    /**
     * Loads a motion, or entire motion group if no index specified.
     */
    private async loadMotion(group: string, index?: number): Promise<Live2DMotion | void> {
        return new Promise(resolve => {
            const definitionGroup = this.definitions[group];

            if (definitionGroup) {
                const indices = index ? [index] : definitionGroup.keys();

                const loader = new Loader();

                for (const i of indices as any) {
                    const definition = definitionGroup[i];

                    if (definition) {
                        loader.add(
                            this.modelSettings.resolvePath(definition.file),
                            {
                                xhrType: LoaderResource.XHR_RESPONSE_TYPE.BUFFER,
                                metadata: { definition, index: i },
                            },
                        );
                    }
                }

                loader
                    .on('load', (loader: Loader, resource: LoaderResource) => {
                        const definition = resource.metadata.definition as MotionDefinition;

                        try {
                            const motion = Live2DMotion.loadMotion(resource.data);

                            motion.setFadeIn(definition.fadeIn! > 0 ? definition.fadeIn! : DEFAULT_FADE_TIMEOUT);
                            motion.setFadeOut(definition.fadeOut! > 0 ? definition.fadeOut! : DEFAULT_FADE_TIMEOUT);

                            this.motionGroups[group][resource.metadata.index] = motion;

                            resolve(motion);
                        } catch (e) {
                            warn(this.tag, `Failed to load motion [${definition.name}]: ${definition.file}`, e);
                        }
                    })
                    .load(() => resolve());
            } else {
                resolve();
            }
        });
    }

    async startMotionByPriority(group: string, index: number, priority: Priority = Priority.Normal): Promise<boolean> {
        if (priority !== Priority.Force && (priority <= this.currentPriority || priority <= this.reservePriority)) {
            log(this.tag, 'Cannot start motion because another motion of same or higher priority is running');
            return false;
        }

        this.reservePriority = priority;

        const motion =
            (this.motionGroups[group] && this.motionGroups[group][index]) || (await this.loadMotion(group, index));
        if (!motion) return false;

        if (priority === this.reservePriority) {
            this.reservePriority = Priority.None;
        }

        this.currentPriority = priority;

        log(this.tag, 'Start motion:', this.definitions[group][index].file);

        if (priority > Priority.Idle) {
            this.expressionManager && this.expressionManager.resetExpression();
        }

        this.startMotion(motion);

        return true;
    }

    startRandomMotion(group: string, priority: Priority = Priority.Normal) {
        const groupDefinitions = this.definitions[group];

        if (groupDefinitions && groupDefinitions.length > 0) {
            const index = Math.floor(Math.random() * groupDefinitions.length);
            this.startMotionByPriority(group, index, priority).then();
        }
    }

    update() {
        if (this.isFinished()) {
            if (this.currentPriority > Priority.Idle) {
                this.expressionManager && this.expressionManager.restoreExpression();
            }
            this.currentPriority = Priority.None;
            this.startRandomMotion(Group.Idle, Priority.Idle);
        }

        const updated = this.updateParam(this.coreModel);

        this.expressionManager && this.expressionManager.update();

        return updated;
    }
}
