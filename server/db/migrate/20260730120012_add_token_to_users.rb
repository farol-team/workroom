class AddTokenToUsers < ActiveRecord::Migration[8.1]
  def change
    # Development sign-in. Replaced by OmniAuth-issued sessions.
    add_column :users, :api_token, :string
    add_index  :users, :api_token, unique: true
  end
end
