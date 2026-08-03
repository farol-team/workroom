# A persona the team agreed on: what an agent is called, what it runs, what it
# is told, which model it starts on. The description and nothing else — an
# agent is still a process on one person's machine, under their credentials,
# on their bill (Article P2). A definition here means every colleague's @crm
# is the same @crm (#233).
class AgentDefinition < ApplicationRecord
  belongs_to :workspace

  # The same shape the client's AGENT_NAME enforces: the name is how the agent
  # is addressed, and what @ cannot reach is not a name.
  NAME = /\A[a-z0-9][a-z0-9._-]*\z/i

  validates :name, presence: true, format: { with: NAME },
                   uniqueness: { scope: :workspace_id }
  validates :command, presence: true
end
