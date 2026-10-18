/*
 * Copyright (c) 2026 CleverNimbus
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Left panel of the Hashing tab: the order in which agents must be run given
 * the hash changes at the time the user last generated the plan. The plan
 * lives in `data/execution-plan.json`; this component only reads it, lets
 * the user regenerate it on demand, and lets them tick each step "done".
 */
import { computed, onMounted, ref } from 'vue';
import { formatTime } from '../format.js';
import {
  generateExecutionPlan,
  loadExecutionPlan,
  setExecutionStepDone,
  store,
} from '../store.js';

export default {
  name: 'ExecutionPlanPanel',
  setup() {
    const error = ref('');
    const toggling = ref(new Set());

    const reload = async () => {
      error.value = '';
      try {
        await loadExecutionPlan();
      } catch (err) {
        error.value = err.message;
      }
    };

    const generate = async () => {
      error.value = '';
      try {
        await generateExecutionPlan();
      } catch (err) {
        error.value = err.message;
      }
    };

    const toggleDone = async (step) => {
      const code = step.code;
      toggling.value.add(code);
      try {
        await setExecutionStepDone(code, !step.done);
      } catch (err) {
        error.value = err.message;
      } finally {
        toggling.value.delete(code);
      }
    };

    onMounted(() => {
      if (!store.executionPlan.loaded) reload();
    });

    const steps = computed(() => store.executionPlan.steps);
    const hasPlan = computed(
      () => store.executionPlan.loaded && steps.value.length > 0,
    );
    const noPlan = computed(
      () => store.executionPlan.loaded && steps.value.length === 0,
    );

    /**
     * Paths the hash grid currently reports as changed. Same rule the right
     * side of the tab uses to draw its yellow dot. Comparing this set with
     * the plan's saved `changedPaths` tells us whether the plan is stale.
     */
    const currentChangedPaths = computed(() => {
      const out = new Set();
      const doc = store.hashes.doc ?? {};
      for (const file of doc.files ?? []) {
        const history = Array.isArray(file.hashes) ? file.hashes : [];
        if (history.length >= 2 && history[0]?.hash !== history[1]?.hash) out.add(file.path);
      }
      for (const folder of doc.folders ?? []) {
        const history = Array.isArray(folder.hashes) ? folder.hashes : [];
        if (history.length >= 2 && history[0]?.hash !== history[1]?.hash) out.add(folder.path);
      }
      return out;
    });

    const savedChangedPaths = computed(() => new Set(store.executionPlan.changedPaths));

    const outdated = computed(() => {
      if (!hasPlan.value) return false;
      const current = currentChangedPaths.value;
      const saved = savedChangedPaths.value;
      if (current.size !== saved.size) return true;
      for (const path of current) if (!saved.has(path)) return true;
      return false;
    });

    const outdatedDelta = computed(() => {
      if (!outdated.value) return { added: [], removed: [] };
      const current = currentChangedPaths.value;
      const saved = savedChangedPaths.value;
      const added = [];
      const removed = [];
      for (const path of current) if (!saved.has(path)) added.push(path);
      for (const path of saved) if (!current.has(path)) removed.push(path);
      added.sort();
      removed.sort();
      return { added, removed };
    });

    return {
      error,
      formatTime,
      generate,
      generateLabel: computed(() => (store.executionPlan.loading ? 'Generating…' : 'Generate plan')),
      hasPlan,
      noPlan,
      outdated,
      outdatedDelta,
      reload,
      steps,
      store,
      toggleDone,
      toggling,
    };
  },
  template: `
    <div class="execution-plan">
      <header class="toolbar">
        <span class="execution-plan-title">Execution plan</span>
        <span class="spacer"></span>
        <button type="button" :disabled="store.executionPlan.loading" @click="reload">Reload</button>
        <button
          type="button"
          class="primary"
          :disabled="store.executionPlan.loading"
          :title="'Recompute the plan from the current hash and save it to data/execution-plan.json'"
          @click="generate"
        >{{ generateLabel }}</button>
      </header>

      <p v-if="error" class="setting-error">{{ error }}</p>

      <p
        v-else-if="hasPlan && outdated"
        class="execution-plan-outdated"
        :title="'Saved plan was generated from a different set of changed paths. Re-generate to refresh.'"
      >
        <span class="execution-plan-outdated-tag">OUTDATED</span>
        The hash grid now shows
        <span v-if="outdatedDelta.added.length > 0">
          {{ outdatedDelta.added.length }} new changed path{{ outdatedDelta.added.length === 1 ? '' : 's' }}
        </span>
        <span v-if="outdatedDelta.added.length > 0 && outdatedDelta.removed.length > 0"> and </span>
        <span v-if="outdatedDelta.removed.length > 0">
          {{ outdatedDelta.removed.length }} path{{ outdatedDelta.removed.length === 1 ? '' : 's' }} no longer changed
        </span>.
      </p>

      <p v-else-if="hasPlan" class="execution-plan-subtitle">
        Generated {{ formatTime(store.executionPlan.generatedAt) }} from
        {{ store.executionPlan.changedPaths.length }} changed path{{ store.executionPlan.changedPaths.length === 1 ? '' : 's' }}.
      </p>

      <p v-if="noPlan" class="panel-note">
        No plan yet. Click <em>Generate plan</em> to compute one from the latest hash run and save it to
        <code>data/execution-plan.json</code>.
      </p>

      <ol v-if="hasPlan" class="execution-plan-steps">
        <li
          v-for="(step, index) in steps"
          :key="step.code"
          class="execution-plan-step"
          :class="{ 'is-done': step.done }"
        >
          <label class="execution-plan-step-head">
            <input
              type="checkbox"
              class="execution-plan-done"
              :checked="step.done"
              :disabled="toggling.has(step.code)"
              @change="toggleDone(step)"
            />
            <span class="execution-plan-num">{{ index + 1 }}.</span>
            <span class="execution-plan-code">{{ step.code }}</span>
            <span class="execution-plan-name">{{ step.name }}</span>
            <span class="badge execution-plan-phase">phase {{ step.phase }}</span>
          </label>
          <!-- One list, three shapes: root hit on an output, root hit on an
               input, and a downstream edge from another agent. -->
          <ul v-if="step.triggers.length > 0" class="execution-plan-triggers">
            <li v-for="(trigger, j) in step.triggers" :key="j">
              <template v-if="trigger.fromCode">
                after <code>{{ trigger.fromCode }}</code>:
                <code>{{ trigger.output }}</code> → <code>{{ trigger.input }}</code>
              </template>
              <template v-else-if="trigger.output">
                output changed: <code>{{ trigger.output }}</code> overlaps <code>{{ trigger.change }}</code>
              </template>
              <template v-else>
                input changed: <code>{{ trigger.input }}</code> overlaps <code>{{ trigger.change }}</code>
              </template>
            </li>
          </ul>
          <div
            v-if="index < steps.length - 1"
            class="execution-plan-arrow"
            aria-hidden="true"
          >↓</div>
        </li>
      </ol>
    </div>
  `,
};
