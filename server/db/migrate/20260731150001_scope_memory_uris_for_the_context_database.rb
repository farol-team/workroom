class ScopeMemoryUrisForTheContextDatabase < ActiveRecord::Migration[8.1]
  # The context database accepts four uri scopes — agent, resources, session,
  # user — and refuses anything else. Channel memory is shared knowledge that
  # belongs to no one person, which makes it a resource.
  def up
    execute <<~SQL
      UPDATE channels
         SET memory_uri = replace(memory_uri, 'viking://channels/', 'viking://resources/channels/')
       WHERE memory_uri LIKE 'viking://channels/%'
    SQL
    execute <<~SQL
      UPDATE memory_entries
         SET uri = replace(uri, 'viking://channels/', 'viking://resources/channels/')
       WHERE uri LIKE 'viking://channels/%'
    SQL
  end

  def down
    execute "UPDATE channels SET memory_uri = replace(memory_uri, 'viking://resources/channels/', 'viking://channels/')"
    execute "UPDATE memory_entries SET uri = replace(uri, 'viking://resources/channels/', 'viking://channels/')"
  end
end
