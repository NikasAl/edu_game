// ============ LLM Providers (pattern from NutriAdvisor) ============

export type ProviderType =
  | 'openai'
  | 'openrouter'
  | 'dashscope'
  | 'ollama'
  | 'llamacpp'
  | 'custom';

export const PROVIDER_PRESETS: Record<
  ProviderType,
  { label: string; baseUrl: string; model: string; needsKey: boolean; hint: string }
> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    hint: 'Ключ с platform.openai.com',
  },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.0-flash-001',
    needsKey: true,
    hint: 'Один ключ — сотни моделей',
  },
  dashscope: {
    label: 'DashScope (Qwen)',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    needsKey: true,
    hint: 'OpenAI-совместимый режим Alibaba Cloud',
  },
  ollama: {
    label: 'Ollama (локально)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    hint: 'Локально, без ключа. На телефоне — Ollama на ПК в той же сети',
  },
  llamacpp: {
    label: 'llama.cpp server (локально)',
    baseUrl: 'http://localhost:8080/v1',
    model: 'local',
    needsKey: false,
    hint: 'Локальный llama-server с OpenAI-совместимым API',
  },
  custom: {
    label: 'Другой (OpenAI-совместимый)',
    baseUrl: '',
    model: '',
    needsKey: true,
    hint: 'Любой сервер с /chat/completions: vLLM, LM Studio, Together и т.д.',
  },
};

export interface LLMProvider {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string; // может быть пустым для локальных провайдеров
  model: string;
  /**
   * Сохранённые модели провайдера (активная — model). У старых записей поля нет:
   * loadProviders мигрирует его лениво как [model]. Переключение активной модели
   * не требует перезаписи/вспоминания точного имени.
   */
  models?: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ============ Учебные материалы ============

/**
 * Материал = карта знаний (контейнер связанных идей).
 * Карты образуют дерево через parentId: в карте могут «лежать» другие карты,
 * которые отображаются на графе узлами-порталами и открываются входом внутрь.
 */
export interface Material {
  id: string;
  title: string;
  description?: string;
  sourceText?: string; // исходный текст для ингеста (для «показать источник»)
  parentId: string | null; // null — корневая карта
  orderIndex: number; // порядок среди карт одного родителя
  createdAt: Date;
}

/** Регион карты = глава/раздел учебника */
export interface Region {
  id: string;
  materialId: string;
  title: string;
  orderIndex: number;
}

/**
 * Атом идеи — главная сущность.
 * Атомарность: формулировка в 1 предложение + 1 пример + проверяемый вопрос.
 */
export interface IdeaNode {
  id: string;
  materialId: string;
  regionId: string;
  title: string;
  formulation: string; // суть идеи одним предложением
  example: string; // один наглядный пример
  misconception?: string; // типичное заблуждение
  sourceRef?: string; // цитата/ссылка на источник
  feynmanQuestion: string; // вопрос для фейнмановского объяснения
  keyTerms: string[]; // ключевые термины (для локального оценщика и подсказок)
  orderIndex: number;
  createdAt: Date;
}

/** Тип ребра графа */
export type EdgeKind = 'hard' | 'soft';

/** Ребро зависимости: для освоения to нужно from */
export interface IdeaEdge {
  id: string;
  materialId: string;
  fromNodeId: string;
  toNodeId: string;
  kind: EdgeKind;
}

// ============ Задания ============

export type TaskType = 'numeric' | 'exact' | 'choice';

/** Параметр шаблона задачи: список допустимых значений для рандомизации */
export interface TaskParam {
  name: string;
  choices: number[];
}

export type AnswerSpec =
  | { kind: 'numeric'; expr: string; tolerance?: number } // expr — выражение от параметров
  | { kind: 'exact'; value: string; alts?: string[] }
  | { kind: 'choice'; options: string[]; correctIndex: number };

export interface Task {
  id: string;
  nodeId: string;
  materialId: string;
  type: TaskType;
  prompt: string; // с подстановками вида {{param}}
  params?: TaskParam[]; // для параметрических задач
  answerSpec: AnswerSpec;
  explanation: string; // разбор (подсказка 3-го уровня)
  hints: string[]; // подсказки 1–2 уровней
  orderIndex: number;
  createdAt: Date;
}

/** Экземпляр параметрической задачи (подставленные значения) */
export interface TaskInstance {
  taskId: string;
  values: Record<string, number>;
  renderedPrompt: string;
  answer: number | string; // для numeric — число, иначе — эталон
  answerError?: string; // numeric: непусто, если формула ответа не вычисляется (задача «сломана»)
}

// ============ Попытки и прогресс ============

export type AttemptKind = 'feynman' | 'task' | 'own';
export type Verdict = 'pass' | 'fail' | 'pending';

export interface Attempt {
  id: string;
  materialId: string;
  nodeId: string;
  kind: AttemptKind;
  taskId?: string; // только для kind='task'
  userAnswer: string;
  verdict: Verdict;
  score?: number; // 0..1, суммарная оценка
  feedback?: string; // текст обратной связи (LLM/оценщик)
  details?: string; // рубрика, заблуждения и т.п.
  createdAt: Date;
}

export type NodeStatus = 'locked' | 'available' | 'in_progress' | 'mastered';

/** Вычисляемое состояние узла (не хранится, считается по попыткам) */
export interface NodeState {
  status: NodeStatus;
  risky: boolean; // доступен, но soft-зависимости не покрыты
  missingHard: string[]; // id непокрытых hard-зависимостей
  missingSoft: string[];
  feynmanPassed: boolean;
  tasksPassed: number; // сколько задач закрыто
  tasksTotal: number;
  ownPassed: boolean;
  trialsDone: number; // из 3
}

export interface NodeProgressRec {
  nodeId: string; // PK
  materialId: string;
  status: NodeStatus;
  masteredAt?: Date;
  srsDue?: Date; // задел под интервальные повторения
  updatedAt: Date;
}

/**
 * Черновик ответов пользователя в узле: всё, что набрано, сохраняется
 * (в том числе неверные ответы) и восстанавливается при повторном входе.
 */
export interface NodeDraft {
  nodeId: string; // PK
  materialId: string;
  feynmanText: string;
  taskAnswers: Record<string, string>; // taskId → набранный ответ
  taskChoices: Record<string, number>; // taskId → выбранный индекс варианта
  ownTaskText: string;
  updatedAt: Date;
}

// ============ LLM-операции ============

/** Результат проверки фейнмановского объяснения */
export interface FeynmanGrade {
  verdict: 'pass' | 'fail';
  accuracy: number; // 0–2: нет фактических ошибок
  completeness: number; // 0–2: названы ключевые компоненты идеи
  ownWords: number; // 0–1: своими словами, не пересказ источника
  misconceptions: string[];
  feedback: string;
}

/** Результат проверки «своей задачи» */
export interface OwnTaskVerdict {
  verdict: 'pass' | 'fail';
  onTopic: boolean; // задача действительно на эту идею
  solvable: boolean; // условие корректно, задача решаема
  answer: string; // ответ, найденный проверяющим
  feedback: string;
}

export interface ParsedAtom {
  title: string;
  formulation: string;
  example: string;
  misconception?: string;
  sourceQuote?: string;
  feynmanQuestion: string;
  keyTerms: string[];
  regionIndex: number;
  needs?: { title: string; kind: EdgeKind }[]; // от чего зависит
}

export interface ParsedRegion {
  title: string;
}

export interface IngestResult {
  regions: ParsedRegion[];
  atoms: ParsedAtom[];
}

// ============ Приложение ============

export type TabId = 'home' | 'map' | 'maps' | 'import' | 'settings';

export interface MetaRec {
  key: string;
  value: string;
}

/** Формат экспорта/импорта (JSON-бэкап) */
export interface BackupPayload {
  app: 'edu_game';
  version: number;
  exportedAt: string;
  materials: Material[];
  regions: Region[];
  nodes: IdeaNode[];
  edges: IdeaEdge[];
  tasks: Task[];
  attempts: Attempt[];
  progress: NodeProgressRec[];
  providers: LLMProvider[];
  drafts?: NodeDraft[];
}

export const NODE_STATUS_META: Record<
  NodeStatus,
  { label: string; color: string; ring: string; bg: string }
> = {
  locked: {
    label: 'Закрыт',
    color: 'text-rose-500',
    ring: 'border-rose-500/60',
    bg: 'bg-rose-500/10',
  },
  available: {
    label: 'Доступен',
    color: 'text-emerald-500',
    ring: 'border-emerald-500/60',
    bg: 'bg-emerald-500/10',
  },
  in_progress: {
    label: 'В работе',
    color: 'text-amber-500',
    ring: 'border-amber-500/60',
    bg: 'bg-amber-500/10',
  },
  mastered: {
    label: 'Освоен',
    color: 'text-emerald-400',
    ring: 'border-emerald-400',
    bg: 'bg-emerald-400/15',
  },
};
