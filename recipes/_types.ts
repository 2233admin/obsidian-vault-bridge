export interface RecipeSecret {
  name: string;
  description: string;
  where?: string;
}

export interface RecipeHealthCheck {
  command: string;
}

export interface RecipeFrontmatter {
  id: string;
  name: string;
  version: string;
  description: string;
  category: 'infra' | 'sense' | 'reflex';
  requires?: string[];
  secrets?: RecipeSecret[];
  health_checks?: RecipeHealthCheck[];
  setup_time?: string;
  cost_estimate?: string;
}

export type RecipeStatusCode = 'unconfigured' | 'configured' | 'healthy' | 'degraded' | 'error';

export interface RecipeStatus {
  id: string;
  code: RecipeStatusCode;
  secrets_present: string[];
  secrets_missing: string[];
  last_heartbeat?: string;
  last_error?: string;
}

export interface RecipeEvent {
  ts: string;
  event: string;
  data?: Record<string, unknown>;
}

export interface Recipe {
  frontmatter: RecipeFrontmatter;
  body: string;
  filePath: string;
}
