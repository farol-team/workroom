class AStorePerWorkspace < ActiveRecord::Migration[8.1]
  # Where this room's context lives, and the key it is reached with. Null means
  # "whatever the environment names", which is every workspace until somebody
  # provisions accounts — and is what keeps the running server working.
  def change
    add_column :workspaces, :openviking_url, :string
    add_column :workspaces, :openviking_api_key, :string
  end
end
